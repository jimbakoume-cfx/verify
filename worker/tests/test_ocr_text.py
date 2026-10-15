"""OCR output handling that needs no model: look-alike folding, code-line characters, line order."""

from __future__ import annotations

from verify_worker.ocr import OcrLine, fold_lookalikes, group_rows, mrz_characters, reading_order


def line(text: str, x0: float, y0: float, x1: float, y1: float, score: float = 1.0) -> OcrLine:
    return OcrLine(text, score, ((x0, y0), (x1, y0), (x1, y1), (x0, y1)))


def test_greek_and_cyrillic_lookalikes_become_latin():
    # Greek capital Rho read for P (seen in the research), Cyrillic letters for others.
    assert fold_lookalikes("IDUT0SΡ00123458") == "IDUT0SP00123458"
    assert fold_lookalikes("РАSSРОRТ") == "PASSPORT"  # Cyrillic Р, А, О, Т
    assert fold_lookalikes("ΜΒΑRGΑ") == "MBARGA"  # Greek Mu, Beta, Alpha


def test_latin_accents_are_kept_in_text():
    assert fold_lookalikes("HÉLÈNE FRANÇOISE") == "HÉLÈNE FRANÇOISE"


def test_fullwidth_forms_fold():
    assert fold_lookalikes("ＡＢＣ１２３＜") == "ABC123<"


def test_mrz_characters():
    assert mrz_characters("P«UTOΜΟDEL‹‹ALEX") == "P<UTOMODEL<<ALEX"
    assert mrz_characters("I<UTO D231 458907 <<<<") == "I<UTOD231458907<<<<"
    assert mrz_characters("ÉCHANTILLON<<FRANÇOIS") == "ECHANTILLON<<FRANCOIS"
    assert mrz_characters("abc|<") == "ABCI<"
    # No ICAO correction here: O stays O, 0 stays 0 (the Edge Function corrects by field).
    assert mrz_characters("UT0O") == "UT0O"
    assert set(mrz_characters("x!@#$%^&*()_+=~`é")) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<")


def test_rows_and_reading_order():
    lines = [
        line("RIGHT", 300, 102, 400, 120),
        line("LEFT", 10, 100, 120, 121),
        line("BELOW", 10, 140, 200, 160),
        line("TOP", 50, 20, 200, 40),
    ]
    assert [l.text for l in reading_order(lines)] == ["TOP", "LEFT", "RIGHT", "BELOW"]
    assert [[l.text for l in row] for row in group_rows(lines)] == [["TOP"], ["LEFT", "RIGHT"], ["BELOW"]]


def test_line_geometry():
    wide = line("ABC", 0, 0, 100, 20)
    tall = line("A", 0, 0, 20, 100)
    assert wide.horizontal and not tall.horizontal
    assert (wide.x0, wide.y0, wide.x1, wide.y1, wide.cy) == (0, 0, 100, 20, 10)
