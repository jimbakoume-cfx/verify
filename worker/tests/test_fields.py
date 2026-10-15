"""Printed fields: dates in several formats, labels in both languages, and what is never read."""

from __future__ import annotations

import datetime as dt

import pytest

from verify_worker.fields import extract, find_label, parse_date, to_ascii, value_for
from verify_worker.ocr import OcrLine, OcrPage
from verify_worker.text import normalize

TODAY = dt.date(2026, 10, 14)


@pytest.mark.parametrize(
    "raw, kind, expected",
    [
        ("15.02.1990", "birthDate", "1990-02-15"),
        ("15/02/1990", "birthDate", "1990-02-15"),
        ("15-02-90", "birthDate", "1990-02-15"),
        ("01 06 2032", "expiryDate", "2032-06-01"),
        ("04 JUIL/JUL 1985", "birthDate", "1985-07-04"),
        ("30 JUIN/JUN 2023", "issueDate", "2023-06-30"),
        ("12 MAR 1979", "birthDate", "1979-03-12"),
        ("12 fév/feb 25", "issueDate", "2025-02-12"),
        ("5 AOÛT/AUG 1991", "birthDate", "1991-08-05"),
        ("31 DEC 2032", "expiryDate", "2032-12-31"),
        ("01 OCT 2020", "issueDate", "2020-10-01"),
        ("05OCT2025", "issueDate", "2025-10-05"),  # compact: the O of OCT is not a zero
        ("05OCT25", "expiryDate", "2025-10-05"),
        ("05OCTOBRE2025", "issueDate", "2025-10-05"),
        ("05FEV2025", "issueDate", "2025-02-05"),
        ("05NOV2025", "issueDate", "2025-11-05"),
        ("1O OCT 2O25", "issueDate", "2025-10-10"),
        ("1O.O3.2025", "issueDate", "2025-03-10"),  # letter O read for zeros
        ("2025-03-02", "issueDate", "2025-03-02"),
        ("Né le 07.11.1984 à", "birthDate", "1984-11-07"),
        ("12.03.30", "birthDate", "1930-03-12"),  # a birth year "in the future" is last century
        ("12.03.30", "expiryDate", "2030-03-12"),
        ("XX.XX.1985", "birthDate", "XX.XX.1985"),  # unknown day and month: kept as printed
        ("<<.<<.1985", "birthDate", "<<.<<.1985"),
        ("31.02.2020", "birthDate", None),  # not a real date
        ("15.13.1990", "birthDate", None),
        ("VILLE-TEST", "birthDate", None),
        ("1,65 M", "birthDate", None),
    ],
)
def test_parse_date(raw, kind, expected):
    assert parse_date(raw, kind, TODAY) == expected


def test_labels_in_both_languages():
    assert find_label(normalize("NOM / SURNAME")).field == "surname"
    label = find_label(normalize("DATE DE NAISSANCE / DATE OF BIRTH"))
    assert label.field == "birthDate" and label.words == 6
    assert find_label(normalize("Date of expiry")).field == "expiryDate"
    assert find_label(normalize("PRÉNOMS / GIVEN NAMES")).field == "givenNames"
    assert find_label(normalize("N° DE CARTE / CARD No")).field == "documentNumber"
    # A wrong character or two in a long label.
    assert find_label(normalize("DATE DE DELIVRANCF / DATE 0F ISSUE")).field == "issueDate"


def test_never_read_labels_are_labels_of_nothing():
    for text in (
        "LIEU DE NAISSANCE / PLACE OF BIRTH",
        "PÈRE / FATHER",
        "MÈRE / MOTHER",
        "ADRESSE / ADDRESS",
        "TAILLE / HEIGHT",
        "PROFESSION / OCCUPATION",
        "SIGNES PARTICULIERS / DISTINGUISHING MARKS",
        "IDENTIFIANT UNIQUE / UNIQUE IDENTIFIER",
        "CAN",
    ):
        label = find_label(normalize(text))
        assert label is not None and label.field is None, text


def test_values_are_not_labels():
    for text in ("SPÉCIMEN", "HÉLÈNE TEST", "15.02.1990", "SPC000123", "NOMBRE"):
        assert find_label(normalize(text)) is None, text


def test_values():
    assert value_for("surname", "SPÉCIMEN") == "SPECIMEN"
    assert value_for("givenNames", "Aïcha  Essai") == "AICHA ESSAI"
    assert value_for("surname", "N'DIAYE-ŒUVRE") == "N'DIAYE-OEUVRE"
    assert value_for("surname", "12345") is None
    assert value_for("surname", "X") is None
    assert value_for("documentNumber", "SPC 000 123") == "SPC000123"
    assert value_for("documentNumber", "13/02/2032") is None  # a date is not a number
    assert value_for("documentNumber", "12345678901234567") is None  # the unique identifier
    assert value_for("documentNumber", "ABCDEF") is None  # no digits


def test_ascii():
    assert to_ascii("HÉLÈNE FRANÇOISE") == "HELENE FRANCOISE"
    assert to_ascii("Œ’ß") == "OE'SS"
    assert all(" " <= c <= "~" for c in to_ascii("ÉÀÇ ΩЖ 漢字"))


def page(*rows: tuple[str, float, float], width: int = 1280) -> OcrPage:
    """Lines as (text, x, y); each 24 px tall and 14 px per character."""
    lines = tuple(OcrLine(t, 0.99, ((x, y), (x + 14 * len(t), y), (x + 14 * len(t), y + 24), (x, y + 24))) for t, x, y in rows)
    return OcrPage(0, width, 800, lines)


CARD = page(
    ("NOM / SURNAME", 400, 100),
    ("EXEMPLE", 400, 130),
    ("PRÉNOMS / GIVEN NAMES", 400, 170),
    ("JEAN-PAUL ESSAI", 400, 200),
    ("DATE DE NAISSANCE / DATE OF BIRTH", 400, 240),
    ("07.11.1984", 400, 270),
    ("LIEU DE NAISSANCE / PLACE OF BIRTH", 400, 310),
    ("VILLE-TEST", 400, 340),
    ("PÈRE / FATHER", 400, 380),
    ("ESSAI PAPA", 400, 410),
    ("DATE DE DÉLIVRANCE / DATE OF ISSUE", 400, 450),
    ("12.05.2019", 400, 480),
    ("DATE D'EXPIRATION", 900, 450),
    ("12.05.2029", 900, 480),
    ("IDENTIFIANT UNIQUE / UNIQUE IDENTIFIER", 400, 520),
    ("98765432109876543", 400, 550),
    ("N° DE CARTE / CARD No", 400, 590),
    ("100200300", 400, 620),
)


def test_document_without_code_lines():
    assert extract(CARD, has_code_lines=False) == {
        "surname": "EXEMPLE",
        "givenNames": "JEAN-PAUL ESSAI",
        "birthDate": "1984-11-07",
        "issueDate": "2019-05-12",
        "expiryDate": "2029-05-12",
        "documentNumber": "100200300",
    }


def test_document_with_code_lines_reads_names_and_issue_date_only():
    assert extract(CARD, has_code_lines=True) == {
        "surname": "EXEMPLE",
        "givenNames": "JEAN-PAUL ESSAI",
        "issueDate": "2019-05-12",
    }


def test_never_read_values_never_come_out():
    found = extract(CARD, has_code_lines=False)
    for value in ("VILLE-TEST", "ESSAI PAPA", "98765432109876543"):
        assert value not in found.values()


def test_value_on_the_same_line_or_to_the_right():
    p = page(("1. NOM / SURNAME", 300, 100), ("TESTEUR", 700, 98), ("Date of birth: 01/06/1992", 300, 150), ("5. N° DU PERMIS / LICENCE No", 50, 300), ("13/02/2032", 450, 298), ("DL0042424", 50, 330))
    assert extract(p, has_code_lines=False) == {"surname": "TESTEUR", "birthDate": "1992-06-01", "documentNumber": "DL0042424"}


def test_stacked_labels_do_not_reach_past_another_label():
    # Surname label directly followed by the given-names label: no surname value at all.
    p = page(("NOM / SURNAME", 400, 100), ("PRÉNOMS / GIVEN NAMES", 400, 130), ("PAUL", 400, 160))
    assert extract(p, has_code_lines=False) == {"givenNames": "PAUL"}


def test_value_under_a_never_read_label_is_not_taken():
    # The place of birth sits right of the birth date: its value must not become the birth date.
    p = page(("DATE DE NAISSANCE", 100, 100), ("LIEU DE NAISSANCE", 500, 100), ("VILLE-TEST", 500, 130), ("XX.XX.1984", 100, 130))
    assert extract(p, has_code_lines=False) == {"birthDate": "XX.XX.1984"}


def test_label_repeated_in_the_other_language_on_its_own_line():
    p = page(("DATE DE NAISSANCE", 400, 100), ("DATE OF BIRTH", 400, 126), ("15.02.1990", 400, 152))
    assert extract(p, has_code_lines=False) == {"birthDate": "1990-02-15"}


def test_subtype_is_added():
    assert extract(page(), has_code_lines=True, subtype="refugee") == {"subtype": "refugee"}
