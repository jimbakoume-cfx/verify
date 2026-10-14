"""Candidate code lines (MRZ) among the OCR lines. Selection only, no correction.

The Edge Function runs the shared corrector and parser (supabase/functions/_shared/mrzCorrect.ts
and mrz.ts) on these candidates, exactly as on the phone's report: one corrector, one parser. So
this module only picks the rows that may be code lines and maps them to A-Z, 0-9 and '<'. It never
swaps O for 0 or fixes a length: a change made here would be a second, divergent corrector.

A row of the page may hold a code line cut into several boxes (the detector sometimes splits it
at a long run of '<'): the boxes of one row are joined, left to right, before the checks below,
with a space between boxes, so that two printed phrases on one row still count as separate words.

Every candidate leaves the worker, so a printed row must not pass: parents' names in capitals and
bilingual titles have the length of a code line and may start like one (PIERRE..., PERMIS DE...).
"""

from __future__ import annotations

import re

from .contract import MRZ_LAYOUT, WORKER_LIMITS
from .ocr import OcrPage, group_rows, mrz_characters

# Code lines are 30 (TD1) or 44 (TD3) characters; OCR may drop or add a few fillers, which the
# shared corrector repairs within 2. A little more slack here costs nothing: the corrector discards
# what it cannot use.
_LENGTHS = sorted({layout["length"] for layout in MRZ_LAYOUT.values()})
_SLACK = 4
# Birth date, its check digit, sex, expiry date (TD1 line 2 and TD3 line 2).
_DATES = re.compile(r"[0-9]{6}[0-9<][MFX<][0-9]{6}")
# Document code and issuing state at the start of TD1 line 1 / TD3 line 1 (P<UTO, I<CMR, IDCMR...).
_HEADER = re.compile(r"^[PIAC][A-Z<][A-Z<]{3}")
# Where TD1 line 1 carries the document number and its check digit (positions 6-15), with one
# character of slack for OCR.
_NUMBER = slice(5, 16)


def _length_fits(n: int) -> bool:
    return any(abs(n - length) <= _SLACK for length in _LENGTHS)


def looks_like_code_line(raw: str) -> tuple[bool, str]:
    """Whether a row of OCR text may be a code line, and its characters as A-Z, 0-9 and '<'."""
    chars = mrz_characters(raw)
    if not _length_fits(len(chars)):
        return False, chars
    compact = raw.replace(" ", "")
    # Code lines are capitals, digits and fillers only: printed text has lower case, punctuation and
    # spaces between words.
    if any(c.islower() for c in compact):
        return False, chars
    if raw.count(" ") > 3 or len(compact) - len(chars) > 3:
        return False, chars
    if chars.count("<") >= 2 or _DATES.search(chars):
        return True, chars
    # The header alone is not enough: a name or a title in capitals can start the same way. Line 1
    # of a TD1 card always has the document number's check digit where the number ends, and TD3
    # line 1 has fillers ("P<"); printed words have neither.
    if _HEADER.match(chars) and ("<" in chars or any(c.isdigit() for c in chars[_NUMBER])):
        return True, chars
    return False, chars


def find_candidates(page: OcrPage) -> list[str]:
    """The rows that may be code lines, top to bottom, at most WORKER_LIMITS['maxMrzCandidates'].
    When there are more, the lowest rows are kept (code lines sit at the bottom of the page)."""
    found: list[str] = []
    for row in group_rows(page.lines):
        horizontal = [line for line in row if line.horizontal]
        if not horizontal:
            continue
        ok, chars = looks_like_code_line(" ".join(line.text for line in horizontal))
        if ok:
            found.append(chars[: WORKER_LIMITS["maxCandidateLength"]])
    return found[-WORKER_LIMITS["maxMrzCandidates"] :]
