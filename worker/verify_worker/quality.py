"""Photo quality on the server: a numpy port of the rider app's capture engine (packages/capture).

The phone measured its photo before uploading it; this measures it again, the same way, on the
bytes the server actually received (a manual shot was never judged at all, and a modified app could
report anything). The photo is reduced to the phone's 480 px analysis width, the guide is placed where
the phone had it (the photo is the guide plus 2% on each side), and then exactly the phone's maths
runs: document detection (detect.ts), the noise-free focus score, brightness and glare
(metrics.ts, analyze.ts). Thresholds stay with the Edge Function; this module only measures.

The port keeps the TypeScript's names, order of operations and rounding (JavaScript's Math.round
rounds halves up), so the two give the same numbers on the same pixels:
tests/test_quality_parity.py compares them on reference images whose expected values were computed
by the TypeScript itself.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from PIL import Image

# --- geometry.ts / analyze.ts / thresholds.ts -------------------------------------------------
ANALYSIS_WIDTH = 480
STILL_CROP_EXPANSION = 0.04
SHARPNESS_INSET = 0.08
SURFACE_INSET = 0.06
FOCUS_REFERENCE_CONTRAST = 40
FOCUS_MAX_GAIN = 3
MIN_DOCUMENT_CONFIDENCE = 0.5

# --- metrics.ts -------------------------------------------------------------------------------
SATURATED_LUMA = 250
MAD_TO_SIGMA = 1 / 0.6745
DETAIL_BINS_PER_LEVEL = 32
DETAIL_HALF_RANGE = 128 * DETAIL_BINS_PER_LEVEL
NOISE_KERNEL_GAIN = 6
MAX_NOISE_RESPONSE = 16 * 255

# --- detect.ts --------------------------------------------------------------------------------
DETECTION_SEARCH_EXPANSION = 0.15
MIN_BOX_FRACTION = 0.4
SEARCH_BANDS = 8
STRONGEST_PER_SIDE = 6
OUTERMOST_PER_SIDE = 3
MIN_CANDIDATE_LEVEL = 2
MAX_EDGE_SLOPE = math.tan((12 * math.pi) / 180)
EDGE_INSET = 0.1
EDGE_SEGMENTS = 4
SOBEL_STEP_GAIN = 8
RANK_CONTRAST_CAP = 10
RANK_SIZE_POWER = 1
RANK_ASPECT_SIGMA = 0.2
EDGE_CONTRAST_RAMP = (4, 12)
EDGE_TO_INTERIOR_RAMP = (1.5, 3)
ASPECT_RAMP = (0.25, 0.5)
TILT_DISAGREEMENT_RAMP = (2.5, 3.4)
PERSPECTIVE_DEG = 3
SLOPE_STEP_DEG = 2


def js_round(x: float) -> int:
    """JavaScript's Math.round: the nearest integer, halves towards +infinity."""
    r = math.floor(x)
    return int(r + 1) if x - r >= 0.5 else int(r)


@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    width: float
    height: float


def expand_rect(r: Rect, fraction: float) -> Rect:
    dx = (r.width * fraction) / 2
    dy = (r.height * fraction) / 2
    return Rect(r.x - dx, r.y - dy, max(0.0, r.width + 2 * dx), max(0.0, r.height + 2 * dy))


def intersect_rect(a: Rect, b: Rect) -> Rect:
    x0 = max(a.x, b.x)
    y0 = max(a.y, b.y)
    x1 = min(a.x + a.width, b.x + b.width)
    y1 = min(a.y + a.height, b.y + b.height)
    if x1 <= x0 or y1 <= y0:
        return Rect(x0, y0, 0, 0)
    return Rect(x0, y0, x1 - x0, y1 - y0)


def clamp_rect(r: Rect, w: float, h: float) -> Rect:
    return intersect_rect(r, Rect(0, 0, w, h))


def guide_in_still(width: int, height: int, expansion: float = STILL_CROP_EXPANSION) -> Rect:
    """Where the guide sits in a still cut as the guide grown by `expansion` (geometry.ts)."""
    return expand_rect(Rect(0, 0, width, height), 1 / (1 + expansion) - 1)


def pixel_bounds(width: int, height: int, roi: Rect | None, border: int = 0) -> tuple[int, int, int, int]:
    """Whole-pixel region [x0, x1) x [y0, y1) inside the image, `border` pixels from its edge."""
    x0, y0, x1, y1 = 0, 0, width, height
    if roi is not None:
        x0 = js_round(roi.x)
        y0 = js_round(roi.y)
        x1 = js_round(roi.x + roi.width)
        y1 = js_round(roi.y + roi.height)
    x0 = max(x0, border)
    y0 = max(y0, border)
    x1 = min(x1, width - border)
    y1 = min(y1, height - border)
    if x1 < x0:
        x1 = x0
    if y1 < y0:
        y1 = y0
    return x0, y0, x1, y1


# ===============================================================================================
# metrics.ts
# ===============================================================================================
def laplacian_variance(gray: np.ndarray, roi: Rect | None = None) -> float:
    """Variance of the 4-neighbour Laplacian inside `roi` (raw: includes sensor noise)."""
    h, w = gray.shape
    x0, y0, x1, y1 = pixel_bounds(w, h, roi, 1)
    n = (x1 - x0) * (y1 - y0)
    if n == 0:
        return 0.0
    d = gray.astype(np.int64)
    c = d[y0:y1, x0:x1]
    lap = d[y0 - 1 : y1 - 1, x0:x1] + d[y0 + 1 : y1 + 1, x0:x1] + d[y0:y1, x0 - 1 : x1 - 1] + d[y0:y1, x0 + 1 : x1 + 1] - 4 * c
    s = int(lap.sum())
    sq = int((lap * lap).sum())
    mean = s / n
    return max(0.0, sq / n - mean * mean)


def _histogram_median(hist: np.ndarray, n: float) -> float:
    """Median of the values counted in `hist` (bin v covers [v - 0.5, v + 0.5)), interpolated."""
    half = n / 2
    cum = np.cumsum(hist)
    # First bin whose running total reaches half (the TypeScript walks while below + hist[v] < half).
    v = int(np.searchsorted(cum, half, side="left"))
    below = float(cum[v - 1]) if v > 0 else 0.0
    within = (half - below) / float(hist[v])
    return 0.5 * within if v == 0 else v - 0.5 + within


def laplacian_detail(gray: np.ndarray, roi: Rect | None = None) -> float:
    """Fine detail that sensor noise cannot fake (see metrics.ts laplacianDetail)."""
    h, w_img = gray.shape
    x0, y0, x1, y1 = pixel_bounds(w_img, h, roi, 3)
    w = x1 - x0
    hh = y1 - y0
    if w < 3 or hh < 3:
        return 0.0
    d = gray.astype(np.int64)
    sw = w + 2
    sh = hh + 2
    # Horizontal 1-4-6-4-1 pass over rows y0-3 .. y0+sh, columns x0-1 .. x0+w.
    rows = d[y0 - 3 : y0 - 3 + sh + 4, :]
    c0 = x0 - 1
    tmp = rows[:, c0 - 2 : c0 - 2 + sw] + 4 * rows[:, c0 - 1 : c0 - 1 + sw] + 6 * rows[:, c0 : c0 + sw] + 4 * rows[:, c0 + 1 : c0 + 1 + sw] + rows[:, c0 + 2 : c0 + 2 + sw]
    # Vertical pass: smoothed image in 1/256 levels.
    s = tmp[0:sh] + 4 * tmp[1 : sh + 1] + 6 * tmp[2 : sh + 2] + 4 * tmp[3 : sh + 3] + tmp[4 : sh + 4]
    lap = s[0 : sh - 2, 1 : sw - 1] + s[2:sh, 1 : sw - 1] + s[1 : sh - 1, 0 : sw - 2] + s[1 : sh - 1, 2:sw] - 4 * s[1 : sh - 1, 1 : sw - 1]
    n = w * hh
    total = int(lap.sum())
    total_sq = int((lap * lap).sum())
    mean = (total / 256) / n
    variance = max(0.0, (total_sq / 65536) / n - mean * mean)
    bins = np.clip((lap + 4) >> 3, -DETAIL_HALF_RANGE, DETAIL_HALF_RANGE) + DETAIL_HALF_RANGE
    hist = np.bincount(bins.ravel(), minlength=2 * DETAIL_HALF_RANGE + 1)
    cum = np.cumsum(hist)
    m = int(np.searchsorted(cum, n / 2, side="left"))
    fold = np.bincount(np.abs(np.arange(hist.size) - m), weights=hist, minlength=2 * DETAIL_HALF_RANGE + 1)
    fold = np.rint(fold).astype(np.int64)
    mad = _histogram_median(fold, n) / DETAIL_BINS_PER_LEVEL
    spread = MAD_TO_SIGMA * mad
    return max(0.0, variance - spread * spread)


def luma_stats(gray: np.ndarray, roi: Rect | None = None) -> tuple[float, float, int]:
    """(mean, variance, count) of luma inside `roi`."""
    h, w = gray.shape
    x0, y0, x1, y1 = pixel_bounds(w, h, roi)
    count = (x1 - x0) * (y1 - y0)
    if count == 0:
        return 0.0, 0.0, 0
    region = gray[y0:y1, x0:x1].astype(np.int64)
    s = int(region.sum())
    sq = int((region * region).sum())
    mean = s / count
    return mean, max(0.0, sq / count - mean * mean), count


def glare(gray: np.ndarray, roi: Rect | None = None, tiles: int = 4) -> tuple[float, float]:
    """(share of saturated pixels in `roi`, highest share in any half-overlapping tile)."""
    h, w = gray.shape
    x0, y0, x1, y1 = pixel_bounds(w, h, roi)
    rw = x1 - x0
    rh = y1 - y0
    if rw == 0 or rh == 0:
        return 0.0, 0.0
    cells = 1 if tiles == 1 else 2 * tiles
    saturated = gray[y0:y1, x0:x1] >= SATURATED_LUMA
    total = int(saturated.sum())
    ratio = total / (rw * rh)
    if tiles == 1 or total == 0:
        return ratio, ratio
    col_cell = (np.arange(rw) * cells) // rw
    row_cell = (np.arange(rh) * cells) // rh
    ys, xs = np.nonzero(saturated)
    counts = np.bincount(row_cell[ys] * cells + col_cell[xs], minlength=cells * cells).reshape(cells, cells)

    def cell_w(i: int) -> int:
        return ((i + 1) * rw) // cells - (i * rw) // cells

    def cell_h(j: int) -> int:
        return ((j + 1) * rh) // cells - (j * rh) // cells

    worst = 0.0
    for j in range(cells - 1):
        hh = cell_h(j) + cell_h(j + 1)
        for i in range(cells - 1):
            area = (cell_w(i) + cell_w(i + 1)) * hh
            if area == 0:
                continue
            count = int(counts[j, i] + counts[j, i + 1] + counts[j + 1, i] + counts[j + 1, i + 1])
            if count / area > worst:
                worst = count / area
    return ratio, worst


def estimate_noise(gray: np.ndarray, roi: Rect | None = None) -> float:
    """Sensor noise (standard deviation, levels) from a [1 -2 1] x [1 -2 1] filter's median response."""
    h, w = gray.shape
    x0, y0, x1, y1 = pixel_bounds(w, h, roi, 1)
    n = (x1 - x0) * (y1 - y0)
    if n == 0:
        return 0.0
    d = gray.astype(np.int64)

    def at(dy: int, dx: int) -> np.ndarray:
        return d[y0 + dy : y1 + dy, x0 + dx : x1 + dx]

    r = at(-1, -1) + at(-1, 1) + at(1, -1) + at(1, 1) - 2 * (at(-1, 0) + at(1, 0) + at(0, -1) + at(0, 1)) + 4 * at(0, 0)
    hist = np.bincount(np.abs(r).ravel(), minlength=MAX_NOISE_RESPONSE + 1)
    return (_histogram_median(hist, n) * MAD_TO_SIGMA) / NOISE_KERNEL_GAIN


# ===============================================================================================
# detect.ts
# ===============================================================================================
@dataclass(frozen=True)
class Detection:
    box: Rect | None
    confidence: float
    angle: float = 0.0
    extent: Rect | None = None


NONE = Detection(None, 0.0)


@dataclass(frozen=True)
class _EdgeLine:
    mid: float
    slope: float
    centre: float


class _Sums:
    """Running sums of the Sobel gradients of the search area, plus integral images over them so a
    window of columns (rows) costs O(1). `col[y][x]`: Gx summed down column x over rows < y;
    `row[y][x]`: Gy summed along row y over columns < x."""

    def __init__(self, gray: np.ndarray, x0: int, y0: int, w: int, h: int):
        d = gray.astype(np.int64)
        sl = d[y0 - 1 : y0 + h + 1, x0 - 1 : x0 + w + 1]
        tl = sl[0:h, 0:w]
        tc = sl[0:h, 1 : w + 1]
        tr = sl[0:h, 2 : w + 2]
        ml = sl[1 : h + 1, 0:w]
        mr = sl[1 : h + 1, 2 : w + 2]
        bl = sl[2 : h + 2, 0:w]
        bc = sl[2 : h + 2, 1 : w + 1]
        br = sl[2 : h + 2, 2 : w + 2]
        gx = tr + 2 * mr + br - tl - 2 * ml - bl
        gy = bl + 2 * bc + br - tl - 2 * tc - tr
        self.w = w
        self.h = h
        col = np.zeros((h + 1, w), dtype=np.int64)
        col[1:] = np.cumsum(gx, axis=0)
        row = np.zeros((h, w + 1), dtype=np.int64)
        row[:, 1:] = np.cumsum(gy, axis=1)
        self.col = col
        self.row = row
        # Integral over columns of `col` (shape h+1 x w+1), and over rows of `row` (h+1 x w+1).
        col_i = np.zeros((h + 1, w + 1), dtype=np.int64)
        col_i[:, 1:] = np.cumsum(col, axis=1)
        row_i = np.zeros((h + 1, w + 1), dtype=np.int64)
        row_i[1:, :] = np.cumsum(row, axis=0)
        self.col_i = col_i
        self.row_i = row_i
        # Python lists: scalar indexing is several times faster than on numpy arrays.
        self._col_i = col_i.tolist()
        self._row_i = row_i.tolist()

    def window_sum(self, vertical: bool, pos: int, k: int, a: int, z: int) -> int:
        """Gradient across an edge near column (row) `pos`, window +-k, over rows (columns) [a, z)."""
        if vertical:
            j0 = max(0, pos - k)
            j1 = min(self.w - 1, pos + k)
            if j1 < j0:
                return 0
            ci = self._col_i
            return (ci[z][j1 + 1] - ci[z][j0]) - (ci[a][j1 + 1] - ci[a][j0])
        j0 = max(0, pos - k)
        j1 = min(self.h - 1, pos + k)
        if j1 < j0:
            return 0
        ri = self._row_i
        return (ri[j1 + 1][z] - ri[j0][z]) - (ri[j1 + 1][a] - ri[j0][a])

    def window_sums(self, vertical: bool, positions: np.ndarray, k: int, a: int, z: int) -> np.ndarray:
        """window_sum for many positions at once (same k, a, z)."""
        n = self.w if vertical else self.h
        j0 = np.maximum(0, positions - k)
        j1 = np.minimum(n - 1, positions + k)
        empty = j1 < j0
        j0 = np.clip(j0, 0, n)
        j1p = np.clip(j1 + 1, 0, n)
        if vertical:
            ci = self.col_i
            out = (ci[z, j1p] - ci[z, j0]) - (ci[a, j1p] - ci[a, j0])
        else:
            ri = self.row_i
            out = (ri[j1p, z] - ri[j0, z]) - (ri[j1p, a] - ri[j0, a])
        out[empty] = 0
        return out

    def line_values(self, vertical: bool, r0: int, r1: int) -> np.ndarray:
        """Window-0 sums over [r0, r1) for every column (row): the gradient of 1-pixel lines."""
        if vertical:
            return self.col[r1] - self.col[r0]
        return self.row[:, r1] - self.row[:, r0]


def _seg_bounds(a: int, z: int) -> tuple[list[int], list[int]]:
    s0 = [a + ((seg * (z - a)) // EDGE_SEGMENTS) for seg in range(EDGE_SEGMENTS)]
    s1 = [a + (((seg + 1) * (z - a)) // EDGE_SEGMENTS) for seg in range(EDGE_SEGMENTS)]
    return s0, s1


def _edge_strength(sums: _Sums, vertical: bool, pos: int, k: int, a: int, z: int) -> float:
    """Contrast of an edge in its second-weakest quarter (luma levels), polarity ignored."""
    s0, s1 = _seg_bounds(a, z)
    values = []
    for seg in range(EDGE_SEGMENTS):
        if s1[seg] > s0[seg]:
            values.append(abs(sums.window_sum(vertical, pos, k, s0[seg], s1[seg])) / (s1[seg] - s0[seg]) / SOBEL_STEP_GAIN)
        else:
            values.append(0.0)
    values.sort()
    return values[1]


def _edge_strengths(sums: _Sums, vertical: bool, positions: np.ndarray, k: int, a: int, z: int) -> np.ndarray:
    s0, s1 = _seg_bounds(a, z)
    rows = []
    for seg in range(EDGE_SEGMENTS):
        if s1[seg] > s0[seg]:
            ws = sums.window_sums(vertical, positions, k, s0[seg], s1[seg])
            rows.append(np.abs(ws) / (s1[seg] - s0[seg]) / SOBEL_STEP_GAIN)
        else:
            rows.append(np.zeros(positions.shape, dtype=np.float64))
    return np.sort(np.stack(rows), axis=0)[1]


def _banded_profile(sums: _Sums, vertical: bool, k: int) -> np.ndarray:
    n = sums.w if vertical else sums.h
    across = sums.h if vertical else sums.w
    acc = np.zeros(n, dtype=np.int64)
    if n - 2 * k > 0:
        positions = np.arange(k, n - k)
        for band in range(SEARCH_BANDS):
            a = (band * across) // SEARCH_BANDS
            z = ((band + 1) * across) // SEARCH_BANDS
            if z <= a:
                continue
            acc[k : n - k] += np.abs(sums.window_sums(vertical, positions, k, a, z))
    return acc / (across * SOBEL_STEP_GAIN)


def _candidates(profile: list[float], k: int, lo_in: int, hi_in: int, from_end: bool) -> list[int]:
    n = len(profile)
    lo = max(lo_in, 1)
    hi = min(hi_in, n - 1)
    peaks: list[int] = []
    i = lo
    while i < hi:
        v = profile[i]
        if not (v > 0 and v > profile[i - 1]):
            i += 1
            continue
        j = i
        while j + 1 < n - 1 and profile[j + 1] == v:
            j += 1
        if profile[j + 1] < v:
            peaks.append(min(hi - 1, (i + j) >> 1))
        i = j + 1
    peaks.sort(key=lambda p: -profile[p])
    kept: list[int] = []
    for p in peaks:
        if all(abs(p - q) > k for q in kept):
            kept.append(p)
    picked = kept[:STRONGEST_PER_SIDE]
    outer = sorted((p for p in kept if profile[p] >= MIN_CANDIDATE_LEVEL), reverse=from_end)
    for p in outer[:OUTERMOST_PER_SIDE]:
        if p not in picked:
            picked.append(p)
    return picked


def _inner_span(lo: float, hi: float, limit: int) -> tuple[int, int]:
    inset = (hi - lo) * EDGE_INSET
    return max(0, math.ceil(lo + inset)), min(limit, math.floor(hi - inset))


def _runs(s0: int, s1: int, slope: float, centre: float) -> list[tuple[int, int, float]]:
    """The pieces lineSum cuts [s0, s1) into, short enough for a slanted line to drift under a pixel,
    with each piece's middle relative to `centre`."""
    if slope == 0:
        return [(s0, s1, 0.0)]
    run = max(1, math.floor(1 / abs(slope)))
    out = []
    r0 = s0
    while r0 < s1:
        r1 = min(s1, r0 + run)
        out.append((r0, r1, (r0 + r1) / 2 - centre))
        r0 += run
    return out


def _line_sum(sums: _Sums, vertical: bool, at: float, slope: float, centre: float, s0: int, s1: int, window: int) -> int:
    if slope == 0:
        return sums.window_sum(vertical, js_round(at - 0.5), window, s0, s1)
    total = 0
    for r0, r1, m in _runs(s0, s1, slope, centre):
        total += sums.window_sum(vertical, js_round(at + slope * m - 0.5), window, r0, r1)
    return total


def _js_round_array(x: np.ndarray) -> np.ndarray:
    r = np.floor(x)
    return (r + (x - r >= 0.5)).astype(np.int64)


def _line_sums_at(sums: _Sums, vertical: bool, positions: np.ndarray, slope: float, centre: float, s0: int, s1: int) -> np.ndarray:
    """_line_sum(at = i + 0.5, window 0) for every integer position i in `positions`."""
    n = sums.w if vertical else sums.h
    at = positions.astype(np.float64) + 0.5
    total = np.zeros(positions.shape, dtype=np.int64)
    pieces = [(s0, s1, None)] if slope == 0 else _runs(s0, s1, slope, centre)
    for r0, r1, m in pieces:
        values = sums.line_values(vertical, r0, r1)
        pos = _js_round_array(at - 0.5) if m is None else _js_round_array(at + slope * m - 0.5)
        inside = (pos >= 0) & (pos <= n - 1)
        total += np.where(inside, values[np.clip(pos, 0, n - 1)], 0)
    return total


def _edge_position(p: np.ndarray, i: int, k: int, outside_is_low: bool) -> float:
    """Sub-pixel position of the edge near index i in a profile (see detect.ts edgePosition)."""
    n = len(p)
    a = max(1, i - k)
    z = min(n - 2, i + k)
    strongest = 0.0
    for j in range(a, z + 1):
        strongest = max(strongest, p[j])
    if not (strongest > 0):
        return i + 0.5
    peak = i
    for step in range(0, z - a + 1):
        j = a + step if outside_is_low else z - step
        if p[j] >= strongest / 2 and p[j] >= p[j - 1] and p[j] >= p[j + 1]:
            peak = j
            break
    floor_ = p[peak] / 2
    lo = peak
    hi = peak
    while lo > max(0, peak - 2 * k) and p[lo - 1] >= floor_:
        lo -= 1
    while hi < min(n - 1, peak + 2 * k) and p[hi + 1] >= floor_:
        hi += 1
    total = 0.0
    moment = 0.0
    for j in range(lo, hi + 1):
        total += p[j]
        moment += p[j] * (j + 0.5)
    return moment / total if total > 0 else peak + 0.5


def _fit_line(along: list[float], across: list[float], fallback: float) -> tuple[float, float]:
    count = len(along)
    if count == 0:
        return fallback, 0.0
    ta = 0.0
    xa = 0.0
    for i in range(count):
        ta += along[i] / count
        xa += across[i] / count
    stt = 0.0
    stx = 0.0
    for i in range(count):
        stt += (along[i] - ta) ** 2
        stx += (along[i] - ta) * (across[i] - xa)
    slope = max(-MAX_EDGE_SLOPE, min(MAX_EDGE_SLOPE, stx / stt)) if stt > 0 else 0.0
    return xa - slope * ta, slope


def _fit_edge(sums: _Sums, vertical: bool, pos: int, k: int, a: int, z: int, outside_is_low: bool) -> _EdgeLine:
    n = sums.w if vertical else sums.h
    centre = (a + z) / 2
    seg0, seg1 = _seg_bounds(a, z)

    def line_profile(positions: np.ndarray, slope: float) -> np.ndarray:
        out = np.zeros(positions.shape, dtype=np.int64)
        for seg in range(EDGE_SEGMENTS):
            out += np.abs(_line_sums_at(sums, vertical, positions, slope, centre, seg0[seg], seg1[seg]))
        return out

    # 1. Slant.
    slope = 0.0
    reach = k
    best = -1.0
    steps = math.floor((math.atan(MAX_EDGE_SLOPE) * 180) / math.pi / SLOPE_STEP_DEG)
    for step in range(2 * steps + 1):
        deg = ((step + 1) / 2 if step % 2 == 1 else -step / 2) * SLOPE_STEP_DEG
        s = math.tan((deg * math.pi) / 180)
        r = k + math.ceil(abs(s) * (z - a) * 0.5)
        p_start = max(0, pos - r - 1)
        p_end = min(n - 1, pos + r)
        score = 0
        if p_end >= p_start + 1:
            values = line_profile(np.arange(p_start, p_end + 1), s)
            pair_max = int((values[1:] + values[:-1]).max())
            score = max(0, pair_max)
        if score > best * 1.02:
            best = score
            slope = s
            reach = r
    if not (best > 0):
        return _EdgeLine(pos + 0.5, 0.0, centre)

    # 2. Position.
    outward = k + math.ceil(abs(slope) * (z - a)) if reach > k else k
    lo_from = max(1, pos - outward if outside_is_low else pos - reach)
    hi_to = min(n - 2, pos + reach if outside_is_low else pos + outward)
    lo = max(0, lo_from - 3 * k)
    hi = min(n - 1, hi_to + 3 * k)
    profile = np.zeros(n, dtype=np.float64)
    if hi >= lo:
        profile[lo : hi + 1] = line_profile(np.arange(lo, hi + 1), slope)
    start = pos
    if reach > k:
        strongest = float(profile[lo_from : hi_to + 1].max()) if hi_to >= lo_from else 0.0
        step = 1 if outside_is_low else -1
        start = lo_from if outside_is_low else hi_to
        while profile[start] < strongest / 2:
            start += step
        start = max(1, min(n - 2, start + k * step))
    plist = profile.tolist()
    mid0 = _edge_position(plist, start, k, outside_is_low)
    along: list[float] = []
    across: list[float] = []
    near = js_round(mid0 - 0.5)
    for seg in range(EDGE_SEGMENTS):
        if seg1[seg] <= seg0[seg]:
            continue
        seg_profile = [0.0] * n
        p_lo = max(0, near - 3 * k)
        p_hi = min(n - 1, near + 3 * k)
        if p_hi >= p_lo:
            values = np.abs(_line_sums_at(sums, vertical, np.arange(p_lo, p_hi + 1), slope, centre, seg0[seg], seg1[seg]))
            seg_profile[p_lo : p_hi + 1] = [float(v) for v in values]
        along.append((seg0[seg] + seg1[seg]) / 2 - centre)
        across.append(_edge_position(seg_profile, near, k, outside_is_low))
    mid, fit_slope = _fit_line(along, across, mid0)
    if len(along) >= 3:
        def residual(i: int) -> float:
            return abs(across[i] - mid - fit_slope * along[i])

        worst = 0
        for i in range(1, len(along)):
            if residual(i) > residual(worst):
                worst = i
        if residual(worst) > max(1, k / 2):
            del along[worst]
            del across[worst]
            mid, fit_slope = _fit_line(along, across, mid0)
    slope = max(-MAX_EDGE_SLOPE, min(MAX_EDGE_SLOPE, slope + fit_slope))
    return _EdgeLine(mid, slope, centre)


def _line_strength(sums: _Sums, vertical: bool, line: _EdgeLine, slope: float, k: int, a: int, z: int) -> tuple[float, int]:
    s0, s1 = _seg_bounds(a, z)
    values = []
    signed = 0
    for seg in range(EDGE_SEGMENTS):
        total = _line_sum(sums, vertical, line.mid, slope, line.centre, s0[seg], s1[seg], k)
        values.append(abs(total) / (s1[seg] - s0[seg]) / SOBEL_STEP_GAIN if s1[seg] > s0[seg] else 0.0)
        signed += total
    values.sort()
    return values[1], signed


def _median(values: np.ndarray) -> float:
    n = values.size
    if n == 0:
        return 0.0
    v = np.sort(values)
    return float(v[n >> 1]) if n % 2 == 1 else float((v[n // 2 - 1] + v[n // 2]) / 2)


def _interior_level(sums: _Sums, l: int, r: int, t: int, b: int, k: int, r0: int, r1: int, c0: int, c1: int) -> float:
    nx = max(0, r - l - 4 * k)
    ny = max(0, b - t - 4 * k)
    cols = math.inf
    rows = math.inf
    if nx > 0:
        cols = _median(_edge_strengths(sums, True, np.arange(l + 2 * k, l + 2 * k + nx), k, r0, r1))
    if ny > 0:
        rows = _median(_edge_strengths(sums, False, np.arange(t + 2 * k, t + 2 * k + ny), k, c0, c1))
    level = min(cols, rows)
    return level if math.isfinite(level) else 0.0


def _corner(v: _EdgeLine, hz: _EdgeLine) -> tuple[float, float]:
    x = (v.mid + v.slope * (hz.mid - hz.slope * hz.centre - v.centre)) / (1 - v.slope * hz.slope)
    return x, hz.mid + hz.slope * (x - hz.centre)


def _ramp(v: float, lo: float, hi: float) -> float:
    if not (v > lo):
        return 0.0
    return 1.0 if v >= hi else (v - lo) / (hi - lo)


def detect_document_box(gray: np.ndarray, guide: Rect) -> Detection:
    """The card as the best rectangle of four straight edges inside the guide grown by 15%."""
    if not (guide.width > 0) or not (guide.height > 0):
        return NONE
    H, W = gray.shape
    x0, y0, x1, y1 = pixel_bounds(W, H, expand_rect(guide, DETECTION_SEARCH_EXPANSION), 1)
    w = x1 - x0
    h = y1 - y0
    k = max(2, js_round(w / 100))
    if w < 6 * k or h < 6 * k:
        return NONE
    min_w = max(2 * k + 1, js_round(guide.width * MIN_BOX_FRACTION))
    min_h = max(2 * k + 1, js_round(guide.height * MIN_BOX_FRACTION))
    guide_aspect = guide.width / guide.height
    guide_area = guide.width * guide.height

    sums = _Sums(gray, x0, y0, w, h)

    # 1. Candidates.
    ax = _banded_profile(sums, True, k).tolist()
    ay = _banded_profile(sums, False, k).tolist()
    lefts = _candidates(ax, k, k, w - k - min_w, False)
    rights = _candidates(ax, k, k + min_w, w - k, True)
    tops = _candidates(ay, k, k, h - k - min_h, False)
    bottoms = _candidates(ay, k, k + min_h, h - k, True)

    # 2. Rank every combination; an edge's value depends only on its position and the span it covers.
    pairs_x = [(a, b) for a in lefts for b in rights if b - a >= min_w]
    pairs_y = [(a, b) for a in tops for b in bottoms if b - a >= min_h]
    cache: dict[tuple[bool, int, int, int], float] = {}

    def rank_value(vertical: bool, pos: int, a: int, z: int) -> float:
        key = (vertical, pos, a, z)
        v = cache.get(key)
        if v is None:
            v = min(RANK_CONTRAST_CAP, _edge_strength(sums, vertical, pos, k, a, z))
            cache[key] = v
        return v

    spans_y = [_inner_span(t, bt, h) for t, bt in pairs_y]
    spans_x = [_inner_span(l, r, w) for l, r in pairs_x]
    best_score = 0.0
    L = R = T = B = -1
    for px, (l, r) in enumerate(pairs_x):
        c0, c1 = spans_x[px]
        for py, (t, bt) in enumerate(pairs_y):
            r0, r1 = spans_y[py]
            v0 = rank_value(True, l, r0, r1)
            v1 = rank_value(True, r, r0, r1)
            aspect_error = math.log((r - l) / (bt - t) / guide_aspect) / RANK_ASPECT_SIGMA
            shape = math.exp(-aspect_error * aspect_error) * (((r - l) * (bt - t)) / guide_area) ** RANK_SIZE_POWER
            if (v0 + v1 + 2 * RANK_CONTRAST_CAP) * shape <= best_score:
                continue
            score = (v0 + v1 + rank_value(False, t, c0, c1) + rank_value(False, bt, c0, c1)) * shape
            if score > best_score:
                best_score = score
                L, R, T, B = l, r, t, bt
    if L < 0:
        return NONE

    # 3. Each edge as a straight, possibly slanted line.
    r0, r1 = _inner_span(T, B, h)
    c0, c1 = _inner_span(L, R, w)
    left = _fit_edge(sums, True, L, k, r0, r1, True)
    right = _fit_edge(sums, True, R, k, r0, r1, False)
    top = _fit_edge(sums, False, T, k, c0, c1, True)
    bottom = _fit_edge(sums, False, B, k, c0, c1, False)
    if right.mid - left.mid < 1 or bottom.mid - top.mid < 1:
        return NONE

    def deg(v: float) -> float:
        return (math.atan(v) * 180) / math.pi

    tilts = [deg(top.slope), deg(bottom.slope), -deg(left.slope), -deg(right.slope)]
    a_t, a_b, a_l, a_r = tilts
    ordered = sorted(tilts)
    angle = (ordered[1] + ordered[2]) / 2
    inconsistency = max(min(abs(a_t - a_b), abs(a_l - a_r)), abs((a_t + a_b) / 2 - (a_l + a_r) / 2))

    def near(tilt: float) -> float:
        return math.tan((max(angle - PERSPECTIVE_DEG, min(angle + PERSPECTIVE_DEG, tilt)) * math.pi) / 180)

    left_at = _line_strength(sums, True, left, -near(a_l), k, r0, r1)
    right_at = _line_strength(sums, True, right, -near(a_r), k, r0, r1)
    top_at = _line_strength(sums, False, top, near(a_t), k, c0, c1)
    bottom_at = _line_strength(sums, False, bottom, near(a_b), k, c0, c1)

    contrast = min(left_at[0], right_at[0], top_at[0], bottom_at[0])
    interior = _interior_level(
        sums,
        js_round(left.mid - 0.5),
        js_round(right.mid - 0.5),
        js_round(top.mid - 0.5),
        js_round(bottom.mid - 0.5),
        k,
        r0,
        r1,
        c0,
        c1,
    )
    aspect_error = abs(math.log((right.mid - left.mid) / (bottom.mid - top.mid) / guide_aspect))
    confidence = min(
        _ramp(contrast, *EDGE_CONTRAST_RAMP),
        _ramp(contrast / max(interior, 0.5), *EDGE_TO_INTERIOR_RAMP),
        1 - _ramp(aspect_error, *ASPECT_RAMP),
        1 - _ramp(inconsistency, *TILT_DISAGREEMENT_RAMP),
    )

    corners = [_corner(v, hz) for v in (left, right) for hz in (top, bottom)]
    ex0 = min(c[0] for c in corners)
    ex1 = max(c[0] for c in corners)
    ey0 = min(c[1] for c in corners)
    ey1 = max(c[1] for c in corners)
    return Detection(
        box=Rect(x0 + left.mid, y0 + top.mid, right.mid - left.mid, bottom.mid - top.mid),
        confidence=confidence,
        angle=angle,
        extent=Rect(x0 + ex0, y0 + ey0, ex1 - ex0, ey1 - ey0),
    )


# ===============================================================================================
# analyze.ts (the measurements; the thresholds are applied by the Edge Function)
# ===============================================================================================
@dataclass(frozen=True)
class QualityMetrics:
    """What the server reports (WorkerQuality, minus the OCR's text line count)."""

    # The phone's "focus" score: noise-free fine detail normalised to a standard contrast, the value
    # the rider app compares with its minSharpness threshold (5).
    sharpness: float
    # The raw Laplacian variance the phone reports as ClientQuality.sharpness (kept for comparison).
    laplacian_variance: float
    glare_ratio: float
    glare_tile_ratio: float
    mean_luma: float
    document_found: bool
    document_confidence: float
    long_side: int


def _focus_score(detail: float, contrast: float) -> float:
    c = max(contrast, FOCUS_REFERENCE_CONTRAST / FOCUS_MAX_GAIN)
    return detail * (FOCUS_REFERENCE_CONTRAST / c) ** 2


def analysis_image(gray: np.ndarray) -> np.ndarray:
    """The photo at the phone's analysis size (480 px wide, or less when the photo is narrower)."""
    h, w = gray.shape
    small_w = min(ANALYSIS_WIDTH, w)
    small_h = max(1, js_round((h * small_w) / w))
    if (small_w, small_h) == (w, h):
        return gray
    return np.asarray(Image.fromarray(gray).resize((small_w, small_h), Image.Resampling.BILINEAR))


def measure_gray(small: np.ndarray, guide: Rect | None = None) -> tuple[Detection, dict[str, float]]:
    """analyzeFrame's measurements on an analysis-size gray image (the guide defaults to the still's)."""
    h, w = small.shape
    if guide is None:
        guide = guide_in_still(w, h)
    detection = detect_document_box(small, guide)
    found = detection.box is not None and detection.confidence >= MIN_DOCUMENT_CONFIDENCE
    area = clamp_rect(detection.box if found else guide, w, h)
    inner = expand_rect(area, -SHARPNESS_INSET)
    sharpness = laplacian_variance(small, inner)
    noise = estimate_noise(small, inner)
    contrast = math.sqrt(max(0.0, luma_stats(small, inner)[1] - noise * noise))
    focus = _focus_score(laplacian_detail(small, inner), contrast)
    surface = expand_rect(area, -SURFACE_INSET)
    luma = luma_stats(small, surface)[0]
    glare_ratio, glare_tile = glare(small, surface, 4)
    return detection, {
        "sharpness": sharpness,
        "noise": noise,
        "contrast": contrast,
        "focus": focus,
        "glareRatio": glare_ratio,
        "glareTileRatio": glare_tile,
        "meanLuma": luma,
    }


def measure(gray: np.ndarray) -> QualityMetrics:
    """Quality of a full-size photo (gray), measured as the phone measures its still."""
    small = analysis_image(gray)
    detection, m = measure_gray(small)
    found = detection.box is not None and detection.confidence >= MIN_DOCUMENT_CONFIDENCE
    return QualityMetrics(
        sharpness=round(m["focus"], 1),
        laplacian_variance=round(m["sharpness"], 1),
        glare_ratio=round(m["glareRatio"], 4),
        glare_tile_ratio=round(m["glareTileRatio"], 4),
        mean_luma=round(m["meanLuma"], 1),
        document_found=found,
        document_confidence=round(detection.confidence, 3),
        long_side=int(max(gray.shape)),
    )
