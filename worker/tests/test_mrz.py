"""Candidate code lines: which OCR rows are kept, and that nothing is corrected."""

from __future__ import annotations

from verify_worker.mrz import check_digit, find_candidates, looks_like_code_line
from verify_worker.ocr import OcrLine, OcrPage

TD1 = ["IDCMRSPC0001239<<<<<<<<<<<<<<<", "9002155F3503029CMR<<<<<<<<<<<2", "SPECIMEN<<HELENE<TEST<<<<<<<<<"]
TD3 = ["P<UTOMODEL<<ALEX<SAMPLE<<<<<<<<<<<<<<<<<<<<<", "UT12345675UTO7903122<3208313<<<<<<<<<<<<<<02"]


def page(rows: list[list[str]], start_y: float = 100, pitch: float = 40) -> OcrPage:
    """Rows of boxes 30 px high, `pitch` px apart (code lines sit about 1.3 heights apart)."""
    lines = []
    for i, texts in enumerate(rows):
        x = 10.0
        for text in texts:
            w = 20.0 * len(text)
            y = start_y + pitch * i
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


# Parents' names as printed on CNI backs (fictitious): code-line length, starting with P, I, A or C.
NAMES = (
    "PIERRE MBARGA ATANGANA NDZANA",
    "CHRISTELLE ABOMO NDONGO ESSOMBA",
    "ANASTASIE NGO MBOCK EPSE BIYONG",
    "ALPHONSE NKOULOU MBARGA",
    "CATHERINE ATANGANA NGONO",
    "PAULINE MBALLA OWONA ESSAMA",
    "IBRAHIM ABDOULAYE MOUSSA",
    "AMINATOU HAMADOU BELLO",
)
# Letters OCR commonly reads as digits in capitals.
MISREADS = {"O": "0", "D": "0", "Q": "0", "A": "4", "S": "5", "B": "8", "I": "1", "L": "1", "Z": "2", "G": "6", "T": "7"}


def misread_once(text: str) -> list[str]:
    return [text[:i] + MISREADS[c] + text[i + 1 :] for i, c in enumerate(text) if c in MISREADS]


def test_rows_in_capitals_are_not_candidates():
    """Every candidate leaves the worker. Parents' names (new and old CNI backs) and bilingual titles
    have the length of a code line and start like one (P, I, A, C), but carry no filler and no right
    check digit where TD1 line 1 has the document number's."""
    for text in (*NAMES, "IDENTIFIANT UNIQUE 12345678901234567"):
        assert looks_like_code_line(text)[0] is False, text
        assert find_candidates(page([[text]])) == [], text


def test_a_name_with_a_letter_misread_as_a_digit_is_not_a_candidate():
    """One OCR confusion (ABOMO read AB0MO) puts a digit where line 1 carries the document number: that
    alone once let a parent's name through. Every single misread of these names stays out, on its own
    and among the rows of a card back."""
    assert looks_like_code_line("CHRISTELLE AB0MO NDONGO ESSOMBA")[0] is False
    assert looks_like_code_line("PIERRE MBARG4 ATANGANA NDZANA")[0] is False
    variants = [variant for name in NAMES for variant in misread_once(name)]
    assert len(variants) > 100
    for variant in variants:
        assert looks_like_code_line(variant)[0] is False, variant
        rows = [["PÈRE / FATHER"], [variant], ["MÈRE / MOTHER"], ["SIGNATURE"]] + [[line] for line in TD1]
        assert find_candidates(page(rows)) == TD1, variant


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


def test_check_digit_is_the_icao_one():
    # ICAO 9303 examples (the shared parser's own test values).
    assert check_digit("L898902C3") == 6
    assert check_digit("D23145890") == 7
    assert check_digit("740812") == 2
    assert check_digit("120415") == 9
    assert check_digit("<<<<<<") == 0


def test_td1_first_line_without_fillers_is_kept():
    # Optional data filling the whole line: no filler, but the number's check digit where it ends.
    assert check_digit("123456789") == 7
    assert looks_like_code_line("IDCMR1234567897123456789012345")[0] is True
    assert looks_like_code_line("I<UTOD231458907<<<<<<<<<<<<<<<")[0] is True


def test_td1_first_line_misread_without_fillers_is_kept_above_line_two():
    """The same line with its number misread (its check digit no longer right) is kept only where line
    1 sits: directly above line 2 (birth and expiry dates), at the spacing of code lines."""
    misread = "IDCMR1234567B97123456789012345"  # an 8 read as B
    line2 = "9002155F3503029CMR<<<<<<<<<<<2"
    line3 = "SPECIMEN<<HELENE<TEST<<<<<<<<<"
    assert looks_like_code_line(misread)[0] is False
    assert find_candidates(page([[misread]])) == []
    assert find_candidates(page([[misread], [line2], [line3]])) == [misread, line2, line3]
    # Not above line 2 (here above line 3), or a printed line's distance away: not kept.
    assert find_candidates(page([[line2], [misread], [line3]])) == [line2, line3]
    assert find_candidates(page([[misread], [line2], [line3]], pitch=80)) == [line2, line3]


def test_a_misread_name_above_line_two_is_kept_only_at_code_line_spacing():
    """When the detector misses line 1, the row above line 2 is whatever was printed above the code
    lines, one line further up: a misread name there stays out."""
    name = "CHRISTELLE AB0MO NDONGO ESSOMBA"
    line2, line3 = TD1[1], TD1[2]
    rows = page([[name], [line2], [line3]])
    gap = OcrPage(rows.rotation, rows.width, rows.height, tuple(
        OcrLine(line.text, line.score, tuple((x, y + (40 if line.text != name else 0)) for x, y in line.box))
        for line in rows.lines
    ))
    assert find_candidates(gap) == [line2, line3]


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
