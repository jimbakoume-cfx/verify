# @verify/capture: on-device capture quality engine

This package decides, about 8 times per second, whether the camera picture of a rider's ID card is
good enough to take. It is plain TypeScript (no React, no DOM), so it runs inside a Web Worker on
mid-range Android phones (Tecno, Itel, Samsung A-series).

It does four things:

1. **Finds the card** in a small grayscale picture (480 px wide) cut around the on-screen guide.
2. **Measures** the card: size, position, brightness, glare, sharpness, and movement since the
   previous picture.
3. **Lists what the rider should fix**, most important first (the "hints").
4. **Takes the photo by itself** once 5 good pictures come in a row (about 0.6 s), then helps
   size and compress the final photo to under 300 KB.

Nothing leaves the phone here: the engine only reads pixels in memory. The server re-checks
every photo later (M3).

## The checks, in the order the rider sees them

Only the first hint is shown to the rider; fixing it reveals the next one. All values below are
the defaults in [`src/thresholds.ts`](src/thresholds.ts). Each can be changed without touching the
code that uses it (see "Tuning on phones").

| # | Hint | What it means | Measured as | Default |
|---|------|---------------|-------------|---------|
| 1 | `no_document` | No card found in or around the guide | Detection confidence, 0 to 1 | below **0.5** |
| 2 | `move_closer` | Card too small in the guide | Card area / guide area | below **0.70** |
| 3 | `move_back` | Card bigger than the guide: it would be cut | Card sticks out of the guide | more than **1.5%** on a side, and too big to fit |
| 4 | `center_document` | Card not centred, sticking out on one side, or held askew | Distance between centres / guide width; tilt | more than **8%**, sticking out more than 1.5%, or tilted more than **4°** |
| 5 | `too_dark` | Not enough light | Mean brightness of the card, 0 to 255 | below **50** |
| 6 | `too_bright` | Over-exposed | Same | above **225** |
| 7 | `glare` | A reflection hides part of the card | Share of blown-out pixels (brightness 250+) | over **2%** of the card, or over **3.5%** of any sixteenth of it |
| 8 | `blurry` | Out of focus or moving | "Focus" score (see below) | below **5** |
| 9 | `hold_still` | The phone or card is moving | Average pixel change since the previous picture | above **7** (after removing camera grain) |

Suggested wording, for the rider app (which owns the final FR/EN text):

| Hint | Français | English |
|------|----------|---------|
| `no_document` | Placez votre pièce d'identité dans le cadre | Place your ID inside the frame |
| `move_closer` | Rapprochez le téléphone | Move the phone closer |
| `move_back` | Éloignez un peu le téléphone | Move the phone back a little |
| `center_document` | Centrez la pièce et tenez-la droite dans le cadre | Centre the ID and keep it straight in the frame |
| `too_dark` | Trop sombre : allez vers la lumière | Too dark: move to a brighter place |
| `too_bright` | Trop de lumière : évitez le soleil direct | Too bright: avoid direct sunlight |
| `glare` | Reflet sur la pièce : inclinez-la légèrement | Glare on the ID: tilt it slightly |
| `blurry` | Image floue : attendez la mise au point | Blurry: let the camera focus |
| `hold_still` | Ne bougez plus | Hold still |

### 1. Finding the card (`no_document`)

The engine looks for four straight edges that form a card-shaped rectangle, inside the guide
grown by 15%. A card edge is a long straight line where brightness changes; printed text inside
the card changes brightness too, but in short strokes that cancel out when added up along a line.

- It works for a **light card on a dark table** and a **darker card on a light table**, and on a
  background that is lighter in some places and darker in others.
- Each edge is checked in four quarters along its length; three of four must be clearly visible,
  so a **finger holding the card** over one quarter of an edge is fine.
- A card held **askew** (up to about 10 degrees) or seen at an angle (the phone not parallel to
  the card, so two opposite edges converge) is still found: each edge is fitted as a slanted
  line, which gives the card's tilt and where its four corners are. The four edges must agree on
  the tilt (allowing for perspective), so a "box" pieced together from unrelated lines in a
  cluttered background does not count.
- The card must be at least 40% of the guide's width and height to be found at all.
- **Confidence** (0 to 1) is the weakest of three signals: the weakest edge must differ from its
  surroundings by at least 4 brightness levels (full marks at 12); it must stand out at least 1.5x
  (full marks at 3x) from the texture inside the card; and the box must be roughly card-shaped.
  Below **0.5**, the rider sees `no_document`.

On test images: every card on a plain, noisy or similar-coloured table scored 1.0; plain and noisy
backgrounds without a card scored 0; cluttered backgrounds without a card scored at most 0.41.

### 2-4. Size and position (`move_closer`, `move_back`, `center_document`)

- **Framing** = how much of the guide the card covers (0.81 for a card at 90% of the guide's
  width). The card must cover at least **70%** (about 84% of the guide's width). At that size the
  card is still about 1300 px wide in the final 1600 px photo.
- **Too close**: the final photo is the guide plus 2% on each side. A card sticking out by more than
  2% would be cut, so the limit is **1.5%** (half a percent is kept for measuring error): a card at
  102% of the guide passes, from 103% the rider is asked to move back. "Sticking out" is measured
  at the card's **corners**: a tilted card's corners reach beyond its edges' midpoints, and
  would be cut first.
- **Centring**: the card's centre must be within **8%** of the guide's width from the guide's
  centre (a card at the minimum size can drift that far and still sit inside the guide). A card of
  the right size that sticks out on one side also gets `center_document`.
- **Straightness**: a card tilted by more than **4 degrees** either way also gets
  `center_document` (the rider app's wording asks to keep the card straight). Below that, a tilted
  card is accepted as long as its corners fit in the photo.

### 5-6. Brightness (`too_dark`, `too_bright`)

The average brightness of the card itself (not the table). The light test card averages 186 and
the darker one 92.

- **Too dark: below 50.** A third of normal light (the light card at 47) fails; a third more
  (65) passes. Dark pictures are noisy and lose the contrast OCR needs.
- **Too bright: above 225.** A white card in good light averages 200-215; above 225 most of the
  card is near pure white.

### 7. Glare (`glare`)

A pixel at brightness 250 or more is "blown out": whatever was printed there is lost. It is
measured on the card a little inside its edges (3% off each side), so a white table showing in the
corners of a slightly tilted card is not taken for glare. Brightness is measured the same way.
Two limits:

- **Spread-out glare:** more than **2%** of the card blown out.
- **A hotspot:** the card is split into a 4 x 4 grid of tiles (overlapping by half, so a spot on a
  tile border is not split in two). More than **3.5%** of any tile blown out fails. On the test
  card, a spot about one character wide (2.5 mm) passes; one about 4 mm wide (two or three
  characters) fails.

### 8. Sharpness (`blurry`)

Sharpness is measured with the **Laplacian**, a standard measure of fine detail (crisp text
strokes): a blurred picture has little, a sharp one a lot. It is measured on the card, a little
inside its border (the border is sharp against almost any table and would hide a blurred card).

Camera grain also looks like fine detail, and a phone's grain is not pixel-by-pixel random: the
camera's processing (colour reconstruction, noise reduction, resizing) smears each speck over its
neighbours. Three steps make the score fair anyway. Together they give the **focus** score, which
is what the threshold applies to:

1. **Light smoothing** (sigma 1 pixel) removes most of the grain; text strokes survive it.
2. **Grain is removed with the same measure.** Grain gives many small, bell-shaped responses;
   sharp text gives rare, strong ones. The engine measures the typical (median) response, which
   only grain sets, and subtracts what it explains. Because grain is measured with the very
   filter that measures detail, this holds for smeared grain too. (An earlier version estimated
   grain with a different filter that assumed pixel-by-pixel grain; it read smeared grain several
   times too low, and a blurred card in dim light then passed.)
3. **Contrast is evened out.** A dim or faded card has weaker strokes than a bright one even when
   perfectly sharp. The score is rescaled as if every card had the same contrast (up to 9x for a
   very dim card), so a dim but sharp card is not called blurry.

Test results (focus): sharp card 70-90; slight blur (about 1 pixel at analysis size, about 3
pixels in the final photo, text still readable) 30 on a clean picture and 19-25 with phone-like
grain (at least 6 for a dark card in dim light with heavy grain): **passes**; blur of 2 pixels or
more, at most 4.4 with or without grain, in any light: **fails**. The limit is **5**. Blur of 1.5
pixels is borderline: it passes on a clean, well-lit picture (10) and fails with grain or in dim
light (3-7).

### 9. Holding still (`hold_still`)

The average brightness change per pixel between this picture and the previous one (one eighth of a
second earlier). Camera grain alone makes pictures differ a little, so the expected grain share is
subtracted first. The grain is measured between the two pictures themselves, on their flattest
quarter (where movement changes little), so smeared grain is counted in full. Moving the light
test card by 1 pixel gives 5.0, by 2 pixels 6.9, by 4 pixels 9.7. The limit is **7**: ordinary
hand tremor passes, real movement does not, and a still phone in dim, grainy light is not asked to
hold still. A darker, lower-contrast card changes less for the same movement, so this check is
more lenient for it.

### Auto-capture

After **5 good pictures in a row** (about 0.6 s at 8 per second), the engine says "capture",
once. It stays quiet until the rider app resets it (after "Retake"). The rider app also offers a
manual shutter after 8 s.

## Calibration

The defaults were chosen on pictures generated in the tests (no real ID images are used or
stored): a card with a patterned background, a header band, a portrait, lines of text and two
MRZ-like lines, placed on a table and then degraded:

- box and Gaussian blur at several strengths, with and without added grain, both pixel-by-pixel
  grain and grain smeared over 0.5 to 1 pixel or a 3 x 3 block, as phone previews have it, in
  normal and dim light;
- white glare spots of several sizes, and six small glints;
- under- and over-exposure;
- cards at 50%, 80%, 90%, 100% and 110% of the guide, off-centre, tilted by up to 10 degrees, and
  seen at an angle (perspective);
- light cards on dark tables, darker cards on light tables, tables close to the card's brightness,
  cluttered tables, and tables with no card at all;
- the same picture shifted by 1, 2, 4 and 8 pixels, with and without fresh grain in each picture.

[`src/calibration.test.ts`](src/calibration.test.ts) states the exact hints each of these
pictures must get. To print every measured value:

```sh
CAPTURE_CALIBRATION=1 npx vitest run packages/capture/src/calibration.test.ts
```

### Tuning on phones

Synthetic pictures are a starting point. Real phones sharpen, denoise and compress their camera
picture, so the PM's phone tests come next:

1. Open the rider link with `?debug=1`: the debug panel shows the live sharpness, glare, brightness,
   framing and movement values.
2. Note the values for clearly good and clearly bad pictures (in daylight, indoors at night, on a
   wooden table, held in the hand).
3. Move each threshold between the good and bad values. Any value can be overridden without changing
   this package: `analyzeFrame(gray, guide, prev, { ...DEFAULT_THRESHOLDS, minSharpness: 8 })`.

## Known limits

- **Cluttered tables.** Objects with long straight edges that touch the card and run parallel to
  it can be taken as part of the card. In the harshest synthetic test (many rectangles of every
  brightness touching the card), the card is found within 8 pixels in about half the scenes; in the
  others the rider sees `no_document` or a framing hint. A plain surface always works; the rider
  app could suggest one when `no_document` lasts.
- **Card the same brightness as the table** (less than about 12 levels apart, e.g. a white card
  on white paper): either `no_document`, or a rectangle printed on the card (portrait edge, header
  band, MRZ) is taken for the card, so size hints are approximate.
- **Tilt.** Measured to within half a degree up to about 10 degrees either way, and the card's
  corners to within about 3 pixels; beyond about 10 degrees the card may not be found
  (`no_document`). Every frame tilted over 4 degrees gets `center_document`, and no accepted frame
  in the tests (cards at 90-102% of the guide, tilted 0-10 degrees, with and without
  perspective) has any part of the card outside the photo. Around 5 and 10 degrees, about 1 test
  scene in 50 still gets `no_document`.
- **Cluttered tables, tilt.** Fitting slanted edges also lets some wrong boxes on the harshest
  cluttered tables look confident: in 40 such scenes, 15 give a confident but wrong box (12
  without the tilt fitting); the card is still found in 16, as before, and no scene without a
  card is taken for one.
- **Card far outside the guide.** A card whose edge lies beyond the search area (the guide plus
  7.5% on each side, e.g. a card at more than 115% of the guide, or shifted far to one side) is not
  found: the rider sees `no_document` rather than `move_back`.
- **Very dark scenes** may show `no_document` first (the priority order is fixed by the spec); the
  hints still include `too_dark`, so the rider app can choose to show it.

## For the rider app: API

Everything is exported from `@verify/capture` and documented in the code (TSDoc).

```ts
import {
  ANALYSIS_WIDTH, DEFAULT_THRESHOLDS, FrameAnalyzer, STILL_CROP_EXPANSION, analysisCrop, analyzeFrame,
  clampRect, compressToTarget, compressionScales, expandRect, guideInStill, guideRect,
  mapViewRectToSource, outputSize, toClientQuality, toGray,
} from "@verify/capture";
import { DOCUMENT_ASPECT } from "@verify/shared";

// Main thread: where the guide is, and what to send to the worker.
const guideView = guideRect(video.clientWidth, video.clientHeight, DOCUMENT_ASPECT.cni);
const guideSrc = mapViewRectToSource(guideView, video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight);
const crop = analysisCrop(guideSrc, video.videoWidth, video.videoHeight); // guide + 20%, 480 px wide
ctx.drawImage(video, crop.source.x, crop.source.y, crop.source.width, crop.source.height, 0, 0, crop.width, crop.height);
const frame = ctx.getImageData(0, 0, crop.width, crop.height);
worker.postMessage({ frame, guide: crop.guide }, [frame.data.buffer]);

// Worker: one object does gray conversion, analysis against the previous frame, and auto-capture.
const analyzer = new FrameAnalyzer(); // or new FrameAnalyzer({ ...DEFAULT_THRESHOLDS, ...overrides })
self.onmessage = ({ data }) => {
  const { analysis, decision } = analyzer.push(data.frame, data.guide);
  self.postMessage({ hints: analysis.hints, metrics: analysis.metrics, decision });
};
// After "Retake": analyzer.reset().

// Still: cut the guide + 4%, size it, compress it.
const stillSrc = clampRect(expandRect(guideSrc, STILL_CROP_EXPANSION), video.videoWidth, video.videoHeight);
const size = outputSize(stillSrc.width, stillSrc.height); // long side <= 1600 px
const { blob, quality, scale } = await compressToTarget(
  // encodeJpeg (rider app): draw stillSrc at size x s on a canvas, then canvas.toBlob(cb, "image/jpeg", q)
  (q, s) => encodeJpeg(video, stillSrc, Math.round(size.width * s), Math.round(size.height * s), q),
  undefined,
  { scales: compressionScales(Math.max(size.width, size.height)) }, // never below the server's minimum (CAPTURE_LIMITS.minLongSide)
);

// Re-check the still (e.g. after a manual capture) on a 480 px wide copy (ImageData), then
// report the metrics with the upload.
const still = toGray(smallCopy.data, smallCopy.width, smallCopy.height);
const check = analyzeFrame(still, guideInStill(still.width, still.height), null);
if (check.hints.includes("blurry") || check.hints.includes("glare")) askToRetake(check.hints);
const clientQuality = toClientQuality(check.metrics, { source: "manual", videoWidth, videoHeight, elapsedMs });
```

| Export | What it does |
|--------|--------------|
| `toGray(rgba, w, h, out?)` | RGBA to gray (Rec. 601). `out` reuses a buffer. |
| `analyzeFrame(gray, guide, prev, thresholds?)` | All checks for one picture: `{ metrics, hints, ok }`. |
| `FrameAnalyzer` | Worker loop helper: gray + `analyzeFrame` + `AutoCapture`, no per-frame allocation. |
| `AutoCapture` | Says "capture" once after N good frames; `progress` (0-1) for a ring around the guide. |
| `HINT_PRIORITY` | All hints in display order (handy for FR/EN key checks). |
| `DEFAULT_THRESHOLDS` | The calibrated limits (read-only; spread to override). |
| `detectDocumentBox(gray, guide)` | The card's box, a confidence, whether it is lighter or darker than the table, its tilt and its corners' extent. |
| `laplacianVariance`, `laplacianDetail`, `meanLuma`, `lumaStats`, `glare`, `estimateNoise`, `frameMotion`, `temporalNoise` | The individual measurements. |
| `guideRect`, `mapViewRectToSource`, `mapSourceRectToView`, `analysisCrop`, `analysisRectToSource`, `guideInStill`, `expandRect`, `clampRect`, `scaleRect`, ... | Geometry between the screen, the video and the analysis picture (`object-fit: cover`). |
| `outputSize`, `compressToTarget`, `compressionScales` | Final photo size and the JPEG quality search (0.88 to 0.56, then the same at 80% size). |
| `toClientQuality(metrics, context)` | The `ClientQuality` object for `POST /flow/captures`. |

`metrics.sharpness` is the raw Laplacian variance (what the contract's `ClientQuality.sharpness`
means); `metrics.focus` is the corrected score the blur check uses. Show both in the debug panel.

## For engineers

- **Speed.** `analyzeFrame` on a 480 x 303 picture takes about 4 ms in Node on a laptop (the test
  fails above 15 ms); expect 3-5 times more on a mid-range phone, well within 125 ms per frame.
  Work buffers are kept between calls, so the loop allocates almost nothing; the module is meant
  to be used from one thread at a time (one worker).
- **Detection details** are in the comments of [`src/detect.ts`](src/detect.ts): Sobel gradients
  summed along rows and columns with running sums, candidate edges, every combination of four
  ranked by edge strength along the box (quarter by quarter), size and shape, then each edge
  fitted as a possibly slanted line (slope search, per-quarter sub-pixel positions, a robust line
  fit) and its corners.
- **Noise**: the blur check measures grain with its own detail filter (median absolute deviation
  of the smoothed Laplacian, robust to text, valid for correlated grain); the steadiness check
  measures it between frames on the flattest pixels. `estimateNoise` (a second-difference filter
  that ignores straight edges and smooth shading) assumes pixel-by-pixel grain and only serves the
  contrast estimate and as a floor.
- **Tests**: `npx vitest run packages/capture`; types: `npm run typecheck -w @verify/capture`.
  Synthetic test pictures come from [`src/test-support/synthetic.ts`](src/test-support/synthetic.ts)
  (test support only, not exported).
- **Licences**: all code here is original; it implements textbook methods (Sobel filter, variance of
  the Laplacian, binomial smoothing, median-based noise estimation) and copies no third-party code.
