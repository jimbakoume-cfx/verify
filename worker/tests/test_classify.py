"""Document-type evidence: keyword groups, sub-type, QR presence, and the choice of rotation."""

from __future__ import annotations

import numpy as np
import pytest

from conftest import SPECIMENS
from verify_worker import classify
from verify_worker.imaging import decode_jpeg, to_gray
from verify_worker.ocr import OcrLine, OcrPage


def line(text: str, y: float, score: float = 0.99, horizontal: bool = True) -> OcrLine:
    w, h = (14.0 * len(text), 24.0) if horizontal else (24.0, 14.0 * len(text))
    return OcrLine(text, score, ((100, y), (100 + w, y), (100 + w, y + h), (100, y + h)))


def page(*lines: OcrLine, rotation: int = 0, size: tuple[int, int] = (1280, 806)) -> OcrPage:
    return OcrPage(rotation, size[0], size[1], tuple(lines))


def test_keyword_groups_are_counted_per_phrase():
    p = page(
        line("RÉPUBLIQUE DU CAMEROUN", 10),
        line("REPUBLIC OF CAMEROON", 40),
        line("CARTE NATIONALE D'IDENTITÉ / NATIONAL IDENTITY CARD", 70),
        line("NOM / SURNAME", 100),
        line("SPECIMEN", 130),
    )
    hits = classify.keyword_hits(p)
    assert list(hits) == list(classify.KEYWORD_GROUPS)
    assert hits["republic"] == 2 and hits["national_id"] == 2 and hits["specimen"] == 1
    assert hits["field_labels"] == 1 and hits["passport"] == 0


def test_residence_titles_share_one_group_and_the_subtype_stays_out_of_it():
    for title, subtype in (
        ("CARTE DE SÉJOUR / RESIDENCE PERMIT", "carte_de_sejour"),
        ("CARTE DE RÉSIDENT / RESIDENCE CARD", "carte_de_resident"),
        ("CARTE DE RÉFUGIÉ / REFUGEE CARD", "refugee"),
    ):
        p = page(line(title, 10))
        hits = classify.keyword_hits(p)
        assert hits["residence"] == 2, title
        assert classify.subtype(p) == subtype
        # Group names never reveal which card it is.
        assert not any("refug" in g or "sejour" in g or "resident" in g for g in hits)


def test_misread_keywords_still_count():
    p = page(line("PERMIS DE C0NDUIRE / DRIVING LICENSE", 10), line("ELECAN", 40))
    hits = classify.keyword_hits(p)
    assert hits["driving_licence"] == 3  # both spellings of licence match "LICENSE"
    assert hits["voter_card"] == 1


def test_sideways_lines_do_not_count():
    assert classify.keyword_hits(page(line("PASSPORT", 10, horizontal=False)))["passport"] == 0


def test_qr_presence(manifest):
    for photo in manifest["photos"]:
        if photo["variant"] != "clean":
            continue
        gray = to_gray(decode_jpeg((SPECIMENS / photo["file"]).read_bytes()).rgb)
        assert classify.qr_present(gray) is photo["expected"]["qr"], photo["file"]


def test_qr_presence_on_nothing():
    assert classify.qr_present(np.full((400, 600), 200, dtype=np.uint8)) is False


def test_first_rotations():
    assert classify.first_rotations("cni_biometric", "document_front") == [90, 270, 0, 180]
    assert classify.first_rotations("residence_permit", "document_front") == [90, 270, 0, 180]
    assert classify.first_rotations("cni_biometric", "document_back") == [0, 180, 90, 270]
    assert classify.first_rotations("passport", "document_front") == [0, 180, 90, 270]


GOOD = [line(t, 30 * i) for i, t in enumerate(["NOM / SURNAME", "SPECIMEN", "PRENOMS / GIVEN NAMES", "HELENE TEST", "DATE OF BIRTH"])]
UPSIDE_DOWN = [line(t, 30 * i, score=0.75) for i, t in enumerate(["3WVNYNS / WON", "NBWIDBdS", "SBWVN NBAIG"])]
SIDEWAYS = [line(t, 30 * i, horizontal=False) for i, t in enumerate(["NOM / SURNAME", "SPECIMEN", "HELENE TEST"])]


class FakeReader:
    """Answers a read per rotation from a table; records the rotations asked for."""

    def __init__(self, by_rotation: dict[int, list[OcrLine]]):
        self.by_rotation = by_rotation
        self.asked: list[int] = []

    def __call__(self, rgb: np.ndarray, rotation: int) -> OcrPage:
        self.asked.append(rotation)
        return page(*self.by_rotation.get(rotation, []), rotation=rotation, size=(rgb.shape[1], rgb.shape[0]))


RGB = np.zeros((806, 1280, 3), dtype=np.uint8)


def test_first_rotation_accepted_when_it_reads_well():
    reader = FakeReader({0: GOOD})
    result = classify.read_oriented(reader, RGB, "passport", "document_front")
    assert reader.asked == [0] and result.page.rotation == 0


def test_upside_down_tries_the_half_turn_next():
    reader = FakeReader({0: UPSIDE_DOWN, 180: GOOD})
    result = classify.read_oriented(reader, RGB, "cni_legacy", "document_front")
    assert reader.asked == [0, 180] and result.page.rotation == 180


def test_sideways_tries_a_quarter_turn_next():
    reader = FakeReader({0: SIDEWAYS, 90: UPSIDE_DOWN, 270: GOOD})
    result = classify.read_oriented(reader, RGB, "driving_licence", "document_front")
    assert reader.asked == [0, 90, 270] and result.page.rotation == 270


def test_portrait_front_starts_sideways_and_falls_back_to_the_plan():
    # An old landscape permit declared as a residence permit: 90 shows sideways text, so 0 comes next.
    reader = FakeReader({90: SIDEWAYS, 0: GOOD})
    result = classify.read_oriented(reader, RGB, "residence_permit", "document_front")
    assert reader.asked == [90, 0] and result.page.rotation == 0
    assert classify.orientation(result.page) == "landscape"


def test_portrait_front_read_upright():
    reader = FakeReader({90: GOOD})
    result = classify.read_oriented(reader, np.zeros((806, 1280, 3), dtype=np.uint8), "cni_biometric", "document_front")
    # The reader gets the rotated image: portrait.
    assert result.page.width < result.page.height
    assert classify.orientation(result.page) == "portrait"


def test_no_text_stops_after_one_read():
    reader = FakeReader({})
    result = classify.read_oriented(reader, RGB, "cni_legacy", "document_front")
    assert reader.asked == [0] and classify.orientation(result.page) is None


def test_thin_text_tries_everything_and_keeps_the_best():
    weak = [line("ABC", 0, score=0.6)]
    reader = FakeReader({0: weak, 180: weak, 90: [line("ABCD EFGH", 0, score=0.95)], 270: weak})
    result = classify.read_oriented(reader, RGB, "cni_legacy", "document_back")
    assert sorted(reader.asked) == [0, 90, 180, 270] and result.page.rotation == 90


def test_code_lines_count_as_evidence():
    two = [line("ABCD", 0), line("EFGH", 30)]
    reader = FakeReader({0: two})
    result = classify.read_oriented(reader, RGB, "passport", "document_front", is_code_line=lambda p: True)
    assert reader.asked == [0] and result.score.keyword_phrases == 2


@pytest.mark.parametrize("lines, expected", [(GOOD, True), (UPSIDE_DOWN, False), (SIDEWAYS, False), ([], False)])
def test_enough(lines, expected):
    assert classify.score_page(page(*lines)).enough is expected
