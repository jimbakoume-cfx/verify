"""Candidate code lines (MRZ) among the OCR lines. Selection only, no correction.

The Edge Function runs the shared corrector and parser (supabase/functions/_shared/mrzCorrect.ts
and mrz.ts) on these candidates, exactly as on the phone's report: one corrector, one parser. So
this module only picks the rows that may be code lines and maps them to A-Z, 0-9 and '<'. It never
swaps O for 0 or fixes a length: a change made here would be a second, divergent corrector.

A row of the page may hold a code line cut into several boxes (the detector sometimes splits it
at a long run of '<'): the boxes of one row are joined, left to right, before the checks below,
with a space between boxes, so that two printed phrases on one row still count as separate words.

Every candidate leaves the worker, so a printed row must not pass: parents' names in capitals and
bilingual titles have the length of a code line and may start like one (PIERRE..., PERMIS DE...),
and OCR may misread one of their letters as a digit (ABOMO as AB0MO). A row is kept only on
structural evidence a printed name cannot have by chance:
- fillers ('<'), or the birth date, sex and expiry date pattern of line 2;
- or the start of line 1 (document code and issuing state) and either a filler, or the document
  number's check digit where it belongs and right (exact ICAO arithmetic on the characters as read,
  nothing corrected);
- or the start of line 1 with a digit in the number, directly above a row with the birth/expiry
  pattern, at the spacing of code lines (line 1 of a card whose number OCR misread, no filler).
"""

from __future__ import annotations

import re

from .contract import MRZ_LAYOUT, WORKER_LIMITS
from .ocr import OcrLine, OcrPage, group_rows, mrz_characters

# Code lines are 30 (TD1) or 44 (TD3) characters; OCR may drop or add a few fillers, which the
# shared corrector repairs within 2. A little more slack here costs nothing: the corrector discards
# what it cannot use.
_LENGTHS = sorted({layout["length"] for layout in MRZ_LAYOUT.values()})
_SLACK = 4
# Birth date, its check digit, sex, expiry date (TD1 line 2 and TD3 line 2).
_DATES = re.compile(r"[0-9]{6}[0-9<][MFX<][0-9]{6}")
# Document code and issuing state at the start of TD1 line 1 / TD3 line 1 (P<UTO, I<CMR, IDCMR...).
_HEADER = re.compile(r"^[PIAC][A-Z<][A-Z<]{3}")
# TD1 line 1: the document number (positions 6-14) and its check digit (position 15).
_TD1_NUMBER = slice(5, 14)
_TD1_NUMBER_CHECK = 14
# Where TD1 line 1 carries the document number and its check digit, with one character of slack.
_NUMBER = slice(5, 16)
# Line 1 directly above line 2: their centres are at most this many row heights apart. Code lines
# are evenly and tightly spaced; a row with a printed line between it and line 2 (or a line 1 the
# detector missed) is about twice as far.
_LINE_PITCH = 1.75

_WEIGHTS = (7, 3, 1)


def _value(c: str) -> int:
    if c.isdigit():
        return ord(c) - ord("0")
    if "A" <= c <= "Z":
        return ord(c) - ord("A") + 10
    return 0  # '<'


def check_digit(field: str) -> int:
    """ICAO 9303 check digit (weights 7, 3, 1; letters 10-35; filler 0), as the shared parser."""
    return sum(_value(c) * _WEIGHTS[i % 3] for i, c in enumerate(field)) % 10


def _number_check_holds(chars: str) -> bool:
    """TD1 line 1: the document number's check digit is where it belongs and right, as read."""
    if len(chars) <= _TD1_NUMBER_CHECK or not chars[_TD1_NUMBER_CHECK].isdigit():
        return False
    return int(chars[_TD1_NUMBER_CHECK]) == check_digit(chars[_TD1_NUMBER])


def _classify(raw: str) -> tuple[str, str]:
    """'line' for a row that is a code line on its own evidence, 'line1' for a row that only starts
    like line 1 of a card with a digit in its number (kept only directly above line 2), 'no'
    otherwise; and the row's characters as A-Z, 0-9 and '<'."""
    chars = mrz_characters(raw)
    if not _length_fits(len(chars)):
        return "no", chars
    compact = raw.replace(" ", "")
    # Code lines are capitals, digits and fillers only: printed text has lower case, punctuation and
    # spaces between words.
    if any(c.islower() for c in compact):
        return "no", chars
    if raw.count(" ") > 3 or len(compact) - len(chars) > 3:
        return "no", chars
    if chars.count("<") >= 2 or _DATES.search(chars):
        return "line", chars
    # The header alone is not enough: a name or a title in capitals can start the same way, and OCR
    # can misread one of its letters as a digit. TD3 line 1 has fillers ("P<"); TD1 line 1 has the
    # document number's check digit, which a misread name matches only by chance.
    if _HEADER.match(chars):
        if "<" in chars or _number_check_holds(chars):
            return "line", chars
        if any(c.isdigit() for c in chars[_NUMBER]):
            return "line1", chars
    return "no", chars


def _length_fits(n: int) -> bool:
    return any(abs(n - length) <= _SLACK for length in _LENGTHS)


def looks_like_code_line(raw: str) -> tuple[bool, str]:
    """Whether a row of OCR text is a code line on its own evidence, and its characters as A-Z, 0-9
    and '<'. A row that only starts like line 1 needs the row below (find_candidates)."""
    kind, chars = _classify(raw)
    return kind == "line", chars


def _span(row: list[OcrLine]) -> tuple[float, float]:
    return min(line.y0 for line in row), max(line.y1 for line in row)


def _directly_above(upper: list[OcrLine], lower: list[OcrLine]) -> bool:
    (top_a, bottom_a), (top_b, bottom_b) = _span(upper), _span(lower)
    height = max(bottom_a - top_a, bottom_b - top_b)
    return 0 < (top_b + bottom_b) / 2 - (top_a + bottom_a) / 2 <= _LINE_PITCH * height


def find_candidates(page: OcrPage) -> list[str]:
    """The rows that may be code lines, top to bottom, at most WORKER_LIMITS['maxMrzCandidates'].
    When there are more, the lowest rows are kept (code lines sit at the bottom of the page)."""
    rows = [[line for line in row if line.horizontal] for row in group_rows(page.lines)]
    rows = [row for row in rows if row]
    read = [_classify(" ".join(line.text for line in row)) for row in rows]
    found: list[str] = []
    for i, (kind, chars) in enumerate(read):
        if kind == "line1":
            below = i + 1 < len(rows) and _DATES.search(read[i + 1][1]) is not None and read[i + 1][0] == "line"
            kind = "line" if below and _directly_above(rows[i], rows[i + 1]) else "no"
        if kind == "line":
            found.append(chars[: WORKER_LIMITS["maxCandidateLength"]])
    return found[-WORKER_LIMITS["maxMrzCandidates"] :]
