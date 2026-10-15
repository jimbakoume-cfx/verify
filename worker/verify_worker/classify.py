"""Evidence of the document type: which way up the photo reads, keyword-group hits, QR presence.

The worker gathers evidence only; the Edge Function decides the type (classification and policy
live in TypeScript). Everything sent is a count or a flag, never text: keyword groups have generic
names, and the groups never tell the residence-card families apart (séjour, résident and refugee
titles all count as "residence"), because check_result, where these counts end up, must not reveal
the card sub-type. That sub-type is read separately into the encrypted fields (fields.py).

Orientation: photos arrive as the capture guide's landscape crop, so most documents read at 0
degrees, but the new CNI and the new foreigner cards have an upright (portrait) front that the rider
turns sideways to fit the guide, in either direction. The rotation tried first comes from the
declared document and side; another is read only when the first gives too little recognisable
text, and the next one is chosen from what the first saw (text running sideways, or upright but
unreadable, i.e. upside down). Each read costs a full OCR pass (seconds of CPU), hence the order.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import cv2
import numpy as np

from .imaging import rotate_clockwise
from .ocr import OcrLine, OcrPage
from .text import contains, normalize

# Phrases are compared after normalize() (no accents, upper case, punctuation as spaces) with up to
# allowed_edits() wrong characters. Each phrase counts once per side. French and English always
# appear together on Cameroonian documents, so both are listed.
KEYWORD_GROUPS: dict[str, tuple[str, ...]] = {
    "republic": ("REPUBLIQUE DU CAMEROUN", "REPUBLIC OF CAMEROON"),
    "national_id": ("CARTE NATIONALE D IDENTITE", "NATIONAL IDENTITY CARD"),
    "passport": ("PASSEPORT", "PASSPORT"),
    # Every residence-card family, on purpose in one group (see the module comment).
    "residence": (
        "CARTE DE SEJOUR",
        "RESIDENCE PERMIT",
        "CARTE DE RESIDENT",
        "RESIDENCE CARD",
        "CARTE DE REFUGIE",
        "REFUGEE CARD",
        "TITRE DE SEJOUR",
    ),
    "driving_licence": ("PERMIS DE CONDUIRE", "DRIVING LICENCE", "DRIVING LICENSE"),
    "voter_card": ("CARTE ELECTORALE", "CARTE D ELECTEUR", "ELECAM", "VOTER CARD", "ELECTIONS CAMEROON"),
    # Field labels: evidence that this is an identity document at all, and that it reads upright.
    "field_labels": (
        "SURNAME",
        "PRENOMS",
        "GIVEN NAMES",
        "DATE DE NAISSANCE",
        "DATE OF BIRTH",
        "NATIONALITE",
        "NATIONALITY",
        "DATE D EXPIRATION",
        "DATE OF EXPIRY",
        "DATE DE DELIVRANCE",
        "DATE OF ISSUE",
    ),
    # A specimen printed as such (a sample image, not a real document).
    "specimen": ("SPECIMEN",),
}

# Card families read from the printed title, for the encrypted fields only. Most specific first. The
# codes are CARD_SUBTYPES in contract.ts (tests/test_contract_sync.py keeps them in sync).
SUBTYPES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("refugee", ("CARTE DE REFUGIE", "REFUGEE CARD", "REFUGIE", "REFUGEE")),
    ("carte_de_resident", ("CARTE DE RESIDENT", "RESIDENCE CARD")),
    ("carte_de_sejour", ("CARTE DE SEJOUR", "RESIDENCE PERMIT", "TITRE DE SEJOUR")),
)

# Fronts printed upright (portrait), which the rider turns sideways to fit the landscape guide.
PORTRAIT_FRONTS = frozenset({"cni_biometric", "residence_permit"})

# Deciding between rotations (provisional, until tuned on real photos). Upright print reads at a
# confidence near 1; upside-down print still comes out as text, but mostly below 0.93.
CONFIDENT_SCORE = 0.93
# A read is accepted when it shows recognisable keywords, a lot of confident text, or (sparse sides,
# such as a licence's categories) only confident text and nothing sideways.
ENOUGH_KEYWORD_PHRASES = 2
ENOUGH_GOOD_LINES = 3
PLENTY_GOOD_LINES = 8
CLEAN_SHARE = 0.8
# Lines shorter than this say nothing about which way the text runs (a lone "A" is as tall as wide).
MIN_ORIENTING_CHARACTERS = 3


def page_text(page: OcrPage) -> str:
    """All the page's horizontal lines, normalised, in reading order (one string, for matching)."""
    return " ".join(normalize(line.text) for line in page.lines if line.horizontal)


def keyword_hits(page: OcrPage) -> dict[str, int]:
    """Phrases found per group (each phrase once), for every group (zero included)."""
    text = page_text(page)
    return {group: sum(1 for phrase in phrases if contains(text, phrase)) for group, phrases in KEYWORD_GROUPS.items()}


def subtype(page: OcrPage) -> str | None:
    text = page_text(page)
    for name, phrases in SUBTYPES:
        if any(contains(text, phrase) for phrase in phrases):
            return name
    return None


def qr_present(gray: np.ndarray) -> bool:
    """Whether a QR code's finder pattern is visible. Detection only: the code is never decoded,
    so its content (identity data on the new cards) is never read, let alone stored."""
    try:
        found, points = cv2.QRCodeDetector().detect(gray)
    except cv2.error:
        return False
    return bool(found) and points is not None


@dataclass(frozen=True)
class ReadScore:
    """How well one rotation reads: what decides between rotations."""

    keyword_phrases: int
    good_lines: int
    good_characters: int
    sideways_lines: int
    horizontal_lines: int

    @property
    def enough(self) -> bool:
        if self.keyword_phrases >= ENOUGH_KEYWORD_PHRASES and self.good_lines >= ENOUGH_GOOD_LINES:
            return True
        if self.good_lines >= PLENTY_GOOD_LINES:
            return True
        clean = self.sideways_lines == 0 and self.good_lines >= CLEAN_SHARE * self.horizontal_lines
        return clean and self.good_lines >= ENOUGH_GOOD_LINES

    @property
    def rank(self) -> tuple[int, int, int]:
        return (self.keyword_phrases, self.good_lines, self.good_characters)

    @property
    def mostly_sideways(self) -> bool:
        return self.sideways_lines > self.horizontal_lines


def _characters(line: OcrLine) -> int:
    return sum(c.isalnum() for c in line.text)


def score_page(page: OcrPage, extra_phrases: int = 0) -> ReadScore:
    """Only lines of a few characters count: they show which way the text runs."""
    lines = [line for line in page.lines if _characters(line) >= MIN_ORIENTING_CHARACTERS]
    good = [line for line in lines if line.horizontal and line.score >= CONFIDENT_SCORE]
    # Keywords count here only when read confidently: garbled upside-down text can come close to a
    # label within the allowed edits.
    confident = OcrPage(page.rotation, page.width, page.height, tuple(good))
    return ReadScore(
        keyword_phrases=sum(keyword_hits(confident).values()) + extra_phrases,
        good_lines=len(good),
        good_characters=sum(_characters(line) for line in good),
        sideways_lines=sum(1 for line in lines if not line.horizontal),
        horizontal_lines=sum(1 for line in lines if line.horizontal),
    )


def first_rotations(declared: str, side: str) -> list[int]:
    """Rotations (clockwise) in the order they are tried, before anything is read."""
    if side == "document_front" and declared in PORTRAIT_FRONTS:
        return [90, 270, 0, 180]
    return [0, 180, 90, 270]


def _next_rotation(tried: list[int], plan: list[int], last: int, last_score: ReadScore) -> int | None:
    """The next rotation: sideways text means the card is a quarter-turn off, upright but
    unreadable text means it is upside down; otherwise the planned order."""
    remaining = [r for r in plan if r not in tried]
    if not remaining:
        return None
    if last_score.mostly_sideways:
        preferred = {(last + 90) % 360, (last + 270) % 360}
    elif last_score.horizontal_lines > 0:
        preferred = {(last + 180) % 360}
    else:
        preferred = set()
    # The planned order decides between the two quarter-turns.
    for r in remaining:
        if r in preferred:
            return r
    return remaining[0]


@dataclass
class OrientedRead:
    page: OcrPage
    score: ReadScore
    tried: list[int] = field(default_factory=list)


def read_oriented(
    read: Callable[[np.ndarray, int], OcrPage],
    rgb: np.ndarray,
    declared: str,
    side: str,
    is_code_line: Callable[[OcrPage], bool] | None = None,
) -> OrientedRead:
    """Reads the photo in the most likely rotation first, others only while the text is too thin;
    returns the best read. `is_code_line` adds evidence: code lines found count as keyword phrases."""
    plan = first_rotations(declared, side)
    tried: list[int] = []
    best: OrientedRead | None = None
    rotation: int | None = plan[0]
    while rotation is not None:
        page = read(rotate_clockwise(rgb, rotation), rotation)
        tried.append(rotation)
        code_lines = is_code_line is not None and is_code_line(page)
        score = score_page(page, 2 if code_lines else 0)
        if best is None or score.rank > best.score.rank:
            best = OrientedRead(page, score)
        # Code lines only read the right way up. Enough text also settles it; and no text at all
        # too: the detector finds print whichever way up it is, so a photo without any line in one
        # orientation has none in the others either.
        if code_lines or score.enough or not page.lines:
            break
        rotation = _next_rotation(tried, plan, rotation, score)
    assert best is not None
    best.tried = tried
    return best


def orientation(page: OcrPage) -> str | None:
    """Landscape or portrait: the shape of the document as read upright. Null without any text."""
    if not page.lines:
        return None
    return "landscape" if page.width >= page.height else "portrait"
