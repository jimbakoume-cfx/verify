"""The few printed fields the worker reads, and nothing more.

Every document: names, document number, birth, expiry and issue dates. On documents with code lines
(passport, new CNI, new foreigner cards) the code lines stay the authoritative source of the number
and dates; since M4 the print is read too, so that the server can compare the two (a printed field
that disagrees with the code lines is flagged for staff). Sex and nationality are never read from the
print: the code lines carry them.

Never read, whatever the document: parents' names, address, height, place of birth, occupation,
distinguishing marks, the 17-digit unique identifier, the passport's card access number (CAN). Their
labels are listed here only so that a line carrying one is never taken as another field's value.

Values are sent as printable ASCII, as the Edge Function requires: names in upper case without
accents, as the code lines write them (HÉLÈNE -> HELENE).

Each value is found next to its French/English label: after the label on the same line, to its
right on the same row, or on the line just below it. Everything here is provisional until tuned on
real documents (label wording, positions, date formats); the dashboard says so.
"""

from __future__ import annotations

import datetime as _dt
import re
import unicodedata
from dataclasses import dataclass

from .contract import WORKER_LIMITS
from .ocr import OcrLine, OcrPage, group_rows
from .text import allowed_edits, normalize

# Labels, compared after normalize(). A label line often holds both languages ("NOM SURNAME").
LABELS: dict[str, tuple[str, ...]] = {
    "surname": ("NOM", "NOMS", "SURNAME", "SURNAMES", "NOM DE FAMILLE"),
    "givenNames": ("PRENOMS", "PRENOM", "GIVEN NAMES", "GIVEN NAME", "FORENAMES"),
    "documentNumber": (
        "NUMERO",
        "N DU DOCUMENT",
        "DOCUMENT NO",
        "DOCUMENT NUMBER",
        "N DE CARTE",
        "NO DE CARTE",
        "CARD NO",
        "CARD NUMBER",
        "N DE PASSEPORT",
        "NO DE PASSEPORT",
        "NUMERO DE PASSEPORT",
        "PASSPORT NO",
        "PASSPORT NUMBER",
        "N DU PERMIS",
        "NUMERO DU PERMIS",
        "LICENCE NO",
        "LICENSE NO",
    ),
    "birthDate": ("DATE DE NAISSANCE", "DATE OF BIRTH", "NE LE", "NEE LE", "NE E LE", "BORN ON"),
    "expiryDate": (
        "DATE D EXPIRATION",
        "DATE OF EXPIRY",
        "DATE OF EXPIRATION",
        "EXPIRY DATE",
        "EXPIRE LE",
        "VALABLE JUSQU AU",
        "VALID UNTIL",
    ),
    "issueDate": ("DATE DE DELIVRANCE", "DATE OF ISSUE", "DELIVRE LE", "ISSUED ON", "DATE D EMISSION"),
}

# Labels of fields that are never read, or not by this module (sex and nationality come from the
# code lines). A line starting with one is a label, never a value.
FORBIDDEN_LABELS: tuple[str, ...] = (
    "PERE",
    "FATHER",
    "MERE",
    "MOTHER",
    "FILIATION",
    "ADRESSE",
    "ADDRESS",
    "DOMICILE",
    "TAILLE",
    "HEIGHT",
    "LIEU DE NAISSANCE",
    "PLACE OF BIRTH",
    "PROFESSION",
    "OCCUPATION",
    "SIGNES PARTICULIERS",
    "DISTINGUISHING MARKS",
    "IDENTIFIANT UNIQUE",
    "UNIQUE IDENTIFIER",
    "NUMERO D IDENTIFICATION UNIQUE",
    "UNIQUE IDENTIFICATION NUMBER",
    "CAN",
    "SEXE",
    "SEX",
    "NATIONALITE",
    "NATIONALITY",
    "AUTORITE",
    "AUTHORITY",
    "LIEU DE DELIVRANCE",
    "PLACE OF ISSUE",
    "POSTE D IDENTIFICATION",
    "IDENTIFICATION POST",
    "SIGNATURE",
    "CATEGORIES",
    "CATEGORY",
    "TYPE",
    "CODE DU PAYS",
    "COUNTRY CODE",
    "BUREAU DE VOTE",
    "POLLING STATION",
)

NAME_FIELDS = ("surname", "givenNames")
DATE_FIELDS = ("birthDate", "expiryDate", "issueDate")
# The same fields with or without code lines since M4 (the server compares them with the code lines).
WITHOUT_CODE_LINES = ("surname", "givenNames", "documentNumber", "birthDate", "expiryDate", "issueDate")
WITH_CODE_LINES = WITHOUT_CODE_LINES

# ---------------------------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------------------------
MONTHS: dict[str, int] = {}
for _number, _names in enumerate(
    (
        ("JAN", "JANV", "JANVIER", "JANUARY"),
        ("FEV", "FEVR", "FEVRIER", "FEB", "FEBRUARY"),
        ("MAR", "MARS", "MARCH"),
        ("AVR", "AVRIL", "APR", "APRIL"),
        ("MAI", "MAY"),
        ("JUIN", "JUN", "JUNE"),
        ("JUIL", "JUILLET", "JUL", "JULY"),
        ("AOU", "AOUT", "AUG", "AUGUST"),
        ("SEP", "SEPT", "SEPTEMBRE", "SEPTEMBER"),
        ("OCT", "OCTOBRE", "OCTOBER"),
        ("NOV", "NOVEMBRE", "NOVEMBER"),
        ("DEC", "DECEMBRE", "DECEMBER"),
    ),
    start=1,
):
    for _name in _names:
        MONTHS[_name] = _number

_MONTH = "|".join(sorted(MONTHS, key=len, reverse=True))
_PART = r"[0-9X<]{2}"
# 05.03.1991, 05/03/91, 05-03-1991 (XX or << for an unknown day or month).
_NUMERIC = re.compile(rf"(?<![0-9])({_PART}) ?[./-] ?({_PART}) ?[./-] ?([0-9]{{4}}|[0-9]{{2}})(?![0-9])")
# 05 MAR 1991, 5 MARS/MAR 91, 05FEV2025.
_WORDS = re.compile(rf"(?<![0-9A-Z])([0-9X<]{{1,2}}) ?((?:{_MONTH}|XXX)(?: ?/ ?(?:{_MONTH}))?) ?([0-9]{{4}}|[0-9]{{2}})(?![0-9])")
# 05 03 1991.
_SPACED = re.compile(rf"(?<![0-9])({_PART}) ({_PART}) ([0-9]{{4}}|[0-9]{{2}})(?![0-9])")
# 1991-03-05.
_ISO = re.compile(r"(?<![0-9])([0-9]{4})-([0-9]{2})-([0-9]{2})(?![0-9])")


def _fold(raw: str) -> str:
    """Upper case without accents, keeping what dates use (digits, letters, . / - and spaces)."""
    text = "".join(ch for ch in unicodedata.normalize("NFKD", raw) if not unicodedata.combining(ch)).upper()
    text = re.sub(r"[^A-Z0-9./\-<]+", " ", text)
    # A letter O touching a digit or a separator is a zero (OCR's usual confusion in printed dates).
    # Month names keep theirs: NOV and AOUT never have it next to a digit, and an O followed by CT
    # starts OCT/OCTOBRE/OCTOBER, as in the compact 05OCT2025.
    return re.sub(r"(?<=[0-9./\-])O(?!CT)|O(?=[0-9./\-])", "0", " ".join(text.split()))


def _full_year(year: int, digits: int, kind: str, today: _dt.date) -> int | None:
    if digits == 4:
        return year if 1900 <= year <= 2099 else None
    if kind == "birthDate":
        # A birth year "in the future" belongs to the previous century.
        return 1900 + year if year > today.year % 100 else 2000 + year
    return 2000 + year


def parse_date(raw: str, kind: str, today: _dt.date | None = None) -> str | None:
    """An ISO date (YYYY-MM-DD) from a printed date; the date as printed (folded) when its day or
    month is unknown (XX); None when the text holds no valid date."""
    today = today or _dt.date.today()
    text = _fold(raw)
    for pattern, words in ((_NUMERIC, False), (_WORDS, True), (_SPACED, False)):
        m = pattern.search(text)
        if not m:
            continue
        day_s, month_s, year_s = m.group(1), m.group(2), m.group(3)
        if words:
            first = re.split(r" ?/ ?", month_s)[0]
            unknown_month = first == "XXX"
            month = 0 if unknown_month else MONTHS[first]
        else:
            unknown_month = "X" in month_s or "<" in month_s
            month = 0 if unknown_month else int(month_s)
        unknown_day = "X" in day_s or "<" in day_s
        year = _full_year(int(year_s), len(year_s), kind, today)
        if year is None:
            return None
        if unknown_day or unknown_month:
            return m.group(0)[: WORKER_LIMITS["maxFieldLength"]]
        try:
            return _dt.date(year, month, int(day_s)).isoformat()
        except ValueError:
            return None
    m = _ISO.search(text)
    if m:
        try:
            return _dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except ValueError:
            return None
    return None


# ---------------------------------------------------------------------------------------------
# Labels
# ---------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Label:
    field: str | None  # None: the label of something never read
    words: int  # how many normalised words the label takes at the start of its line


_PHRASES: list[tuple[str | None, str]] = sorted(
    [(name, phrase) for name, options in LABELS.items() for phrase in options] + [(None, p) for p in FORBIDDEN_LABELS],
    # Longest first: "LIEU DE NAISSANCE" must win over "NE LE", "NOM DE FAMILLE" over "NOM".
    key=lambda item: len(item[1]),
    reverse=True,
)


def _levenshtein(a: str, b: str) -> int:
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            current[j] = min(previous[j - 1] + (ca != cb), previous[j] + 1, current[j - 1] + 1)
        previous = current
    return previous[-1]


def _prefix_match(text: str, phrase: str) -> int | None:
    """Length of the start of `text` that reads as `phrase` (within its allowed edits) and ends on a
    word boundary; None when the text does not start with the phrase."""
    if text == phrase or text.startswith(phrase + " "):
        return len(phrase)
    edits = allowed_edits(phrase)
    if edits == 0:
        return None
    best: tuple[int, int] | None = None
    for length in range(max(1, len(phrase) - edits), min(len(text), len(phrase) + edits) + 1):
        if length < len(text) and text[length] != " ":
            continue
        d = _levenshtein(text[:length], phrase)
        if d <= edits and (best is None or d < best[0]):
            best = (d, length)
    return None if best is None else best[1]


def find_label(text: str) -> Label | None:
    """The label a line starts with (two in a row when bilingual), or None. `text` is normalised."""
    for name, phrase in _PHRASES:
        length = _prefix_match(text, phrase)
        if length is None:
            continue
        rest = text[length:].strip()
        words = len(text[:length].split())
        for other_name, other in _PHRASES:
            if other_name != name:
                continue
            other_length = _prefix_match(rest, other)
            if other_length is not None:
                words += len(rest[:other_length].split())
                break
        return Label(name, words)
    return None


def _after_words(raw: str, skip: int) -> str:
    """The original text (accents kept) after its first `skip` normalised words."""
    tokens = re.sub(r"[:/]", " ", raw).split()
    taken = 0
    i = 0
    while i < len(tokens) and taken < skip:
        taken += len(normalize(tokens[i]).split())
        i += 1
    return " ".join(tokens[i:])


_NAME = re.compile(r"^[A-Z]+(?:[ '-][A-Z]+)*$")
_NUMBER = re.compile(r"^[A-Z0-9]{5,15}$")


def to_ascii(text: str) -> str:
    """Upper-case ASCII, as the code lines write names: accents dropped (É -> E), ligatures spelt
    out (Œ -> OE), typographic apostrophes straightened. The Edge Function accepts printable ASCII
    only in fields, so everything else is dropped."""
    text = text.replace("’", "'").replace("ʼ", "'")
    text = "".join(ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch))
    text = text.upper().replace("Œ", "OE").replace("Æ", "AE").replace("ß", "SS")
    return "".join(ch for ch in text if " " <= ch <= "~")


def value_for(field: str, raw: str) -> str | None:
    """A value for `field` from a piece of printed text, or None when it does not look like one."""
    if field in NAME_FIELDS:
        cleaned = " ".join(to_ascii(raw).replace(",", " ").split()).strip(" :.-")
        if not (2 <= len(cleaned) <= WORKER_LIMITS["maxFieldLength"]):
            return None
        if not _NAME.match(cleaned) or sum(ch.isalpha() for ch in cleaned) < 2:
            return None
        return cleaned
    if field in DATE_FIELDS:
        return parse_date(raw, field)
    if field == "documentNumber":
        # Numbers are letters and digits, maybe spaced; a date (or anything with its separators) is not one.
        if re.search(r"[0-9][./:][0-9]", raw) or parse_date(raw, "issueDate") is not None:
            return None
        compact = normalize(raw).replace(" ", "")
        if not _NUMBER.match(compact) or sum(ch.isdigit() for ch in compact) < 2:
            return None
        # A long run of digits is the unique identifier (17 digits) or another number never kept.
        if re.search(r"[0-9]{12,}", compact):
            return None
        return compact
    return None


def _right_of(line: OcrLine, rows: list[list[OcrLine]]) -> list[OcrLine]:
    for row in rows:
        if any(other is line for other in row):
            return [other for other in row if other is not line and other.x0 >= line.x1 - 2]
    return []


def _below(label: OcrLine, lines: list[OcrLine]) -> list[OcrLine]:
    """Lines just under a label and aligned with it, nearest first."""
    h = max(label.y1 - label.y0, 1.0)
    out = []
    for line in lines:
        if line is label or line.cy <= label.cy:
            continue
        gap = line.y0 - label.y1
        if gap < -0.4 * h or gap > 2.2 * h:
            continue
        overlap = min(label.x1, line.x1) - max(label.x0, line.x0)
        if overlap <= 0 and abs(line.x0 - label.x0) > 2 * h:
            continue
        out.append(line)
    return sorted(out, key=lambda line: (line.y0, abs(line.x0 - label.x0)))


# Item numbers printed before labels ("1. NOM / SURNAME", "4a. DATE DE DELIVRANCE").
_ENUMERATOR = re.compile(r"^(?:[0-9]{1,2}[A-Z]? )+")


def _line_label(line: OcrLine) -> Label | None:
    text = normalize(line.text)
    prefix = _ENUMERATOR.match(text)
    skipped = len(prefix.group(0).split()) if prefix else 0
    label = find_label(text[prefix.end():] if prefix else text)
    if label is None:
        return None
    return Label(label.field, label.words + skipped)


def extract(page: OcrPage, has_code_lines: bool, subtype: str | None = None) -> dict[str, str]:
    """The fields found on one side, by WorkerFields name; fields not found are left out."""
    wanted = WITH_CODE_LINES if has_code_lines else WITHOUT_CODE_LINES
    lines = [line for line in page.lines if line.horizontal]
    rows = group_rows(lines)
    labels = {id(line): _line_label(line) for line in lines}
    found: dict[str, str] = {}
    for line in lines:
        label = labels[id(line)]
        if label is None or label.field not in wanted or label.field in found:
            continue
        value = value_for(label.field, _after_words(line.text, label.words))
        # To the right on the same row, then below. Never past another field's label (stacked
        # labels, or a field that is never read); the same label in the other language, printed
        # on its own line, is stepped over.
        for neighbours in (_right_of(line, rows), _below(line, lines)):
            if value is not None:
                break
            for candidate in neighbours:
                other = labels.get(id(candidate))
                if other is not None:
                    if other.field == label.field:
                        continue
                    break
                value = value_for(label.field, candidate.text)
                if value is not None:
                    break
        if value is not None:
            found[label.field] = value[: WORKER_LIMITS["maxFieldLength"]]
    if subtype is not None:
        found["subtype"] = subtype
    return found
