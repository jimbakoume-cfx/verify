"""Candidate code lines: which OCR rows are kept, and that nothing is corrected."""

from __future__ import annotations

from verify_worker.mrz import find_candidates, looks_like_code_line
from verify_worker.ocr import OcrLine, OcrPage

TD1 = ["IDCMRSPC0001239<<<<<<<<<<<<<<<", "9002155F3503029CMR<<<<<<<<<<<2", "SPECIMEN<<HELENE<TEST<<<<<<<<<"]
TD3 = ["P<UTOMODEL<<ALEX<SAMPLE<<<<<<<<<<<<<<<<<<<<<", "UT12345675UTO7903122<3208313<<<<<<<<<<<<<<02"]


def page(rows: list[list[str]], start_y: float = 100) -> OcrPage:
    lines = []
    for i, texts in enumerate(rows):
        x = 10.0
        for text in texts:
            w = 20.0 * len(text)
            y = start_y + 40 * i
            lines.append(OcrLine(text, 0.99, ((x, y), (x + w, y), (x + w, y + 30), (x, y + 30))))
            x += w + 15
    return OcrPage(0, 1280, 800, tuple(lines))


def test_finds_td1_and_td3_lines_in_order():
    assert find_candidates(page([["NOM / SURNAME"], ["SPÉCIMEN"]] + [[l] for l in TD1])) == TD1
    assert find_candidates(page([["Date of birth"], ["12 MAR 1979"]] + [[l] for l in TD3])) == TD3


def test_split_line_is_joined():
    assert find_candidates(page([["IDCMRSPC0001239", "<<<<<<<<<<<<<<<"]])) == [TD1[0]]


def test_no_correction_is_made():
    raw = "UT12345675UT07903122<3208313<<<<<<<<<<<<<<02"  # 0 where the country code has O
    assert find_candidates(page([[raw]])) == [raw]
    # Look-alikes are only mapped to Latin: a Greek Rho becomes P, nothing else changes.
    assert find_candidates(page([["Ρ<UT0MODEL<<ALEX<SAMPLE<<<<<<<<<<<<<<<<<<<<<"]])) == ["P<UT0MODEL<<ALEX<SAMPLE<<<<<<<<<<<<<<<<<<<<<"]


def test_printed_text_is_not_a_candidate():
    for text in (
        "CARTE NATIONALE D'IDENTITÉ / NATIONAL IDENTITY CARD",
        "DATE DE NAISSANCE / DATE OF BIRTH",
        "IDENTIFIANT UNIQUE / UNIQUE IDENTIFIER 12345678901234567",
        "12345678901234567",
        "Republic of Utopia passport data page 2024",
    ):
        assert looks_like_code_line(text)[0] is False, text


def test_rows_in_capitals_are_not_candidates():
    """Every candidate leaves the worker. Parents' names (new and old CNI backs) and bilingual titles
    have the length of a code line and start like one (P, I, A, C), but carry no filler and no digit
    where TD1 line 1 has its check digit."""
    for text in (
        "PIERRE MBARGA ATANGANA NDZANA",
        "CHRISTELLE ABOMO NDONGO ESSOMBA",
        "ANASTASIE NGO MBOCK EPSE BIYONG",
        "IDENTIFIANT UNIQUE 12345678901234567",
    ):
        assert looks_like_code_line(text)[0] is False, text
        assert find_candidates(page([[text]])) == [], text


def test_two_phrases_on_one_row_are_not_one_code_line():
    # The detector gives a bilingual title as two boxes on one row: the gap between them counts.
    for boxes in (
        ["PERMIS DE CONDUIRE", "DRIVING LICENCE"],
        ["CARTE DE SEJOUR", "RESIDENCE PERMIT"],
        ["CARTE DE RESIDENT", "RESIDENCE CARD"],
    ):
        assert find_candidates(page([boxes])) == [], boxes


def test_a_parents_name_never_joins_the_code_lines():
    rows = [["PÈRE / FATHER"], ["PIERRE MBARGA ATANGANA NDZANA"], ["MÈRE / MOTHER"], ["CHRISTELLE ABOMO NDONGO ESSOMBA"]]
    assert find_candidates(page(rows + [[line] for line in TD1])) == TD1


def test_td1_first_line_without_fillers_is_kept():
    # Optional data filling the whole line: no filler, but the number's check digit where it ends.
    assert looks_like_code_line("IDCMR1234567891123456789012345")[0] is True
    assert looks_like_code_line("I<UTOD231458907<<<<<<<<<<<<<<<")[0] is True


def test_lengths_far_from_30_or_44_are_dropped():
    assert looks_like_code_line("P<UTO<<<<<<")[0] is False
    assert looks_like_code_line("9002155F3503029CMR<<<<<<<<<<<2" * 2)[0] is False


def test_line_with_dates_but_no_fillers():
    # Fillers misread as K: the birth-sex-expiry pattern still marks the line.
    assert looks_like_code_line("9002155F3503029CMRKKKKKKKKKKK2")[0] is True


def test_at_most_eight_lowest():
    rows = [[f"P<UTOMODEL<<ALEX<SAMPLE<<<<<<<<<<<<<<<<<<<<{i}"] for i in range(10)]
    found = find_candidates(page(rows))
    assert len(found) == 8
    assert found[-1].endswith("9") and found[0].endswith("2")


def test_sideways_boxes_are_ignored():
    tall = OcrLine(TD1[0], 0.99, ((10, 10), (40, 10), (40, 700), (10, 700)))
    assert find_candidates(OcrPage(0, 800, 1280, (tall,))) == []
