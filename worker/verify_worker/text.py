"""Text helpers shared by classification and field reading: normalisation and fuzzy matching."""

from __future__ import annotations

import re
import unicodedata

_NON_ALNUM = re.compile(r"[^A-Z0-9]+")


def normalize(text: str) -> str:
    """Accents and case removed, every run of other characters (punctuation, apostrophes, slashes)
    turned into one space: "Date d'expiration / Date of expiry" -> "DATE D EXPIRATION DATE OF EXPIRY"."""
    stripped = "".join(ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch))
    # Letters with no decomposition that French and English text may still use.
    stripped = stripped.replace("Œ", "OE").replace("œ", "oe").replace("Æ", "AE").replace("æ", "ae").replace("ß", "SS")
    return _NON_ALNUM.sub(" ", stripped.upper()).strip()


def allowed_edits(pattern: str) -> int:
    """Wrong characters tolerated for a keyword: none for short words (they would match anything),
    one up to 11 characters, two for longer phrases. One-word labels stay at one: "NATIONALITE" is
    two edits from "NATIONALE" (as in "carte nationale d'identité")."""
    n = len(pattern)
    if n <= 4:
        return 0
    if n <= 11:
        return 1
    return 2


def fuzzy_find(text: str, pattern: str, max_edits: int | None = None) -> int | None:
    """Smallest edit distance (insertions, deletions, substitutions) between `pattern` and any
    substring of `text`, when it is within `max_edits` (default: allowed_edits); otherwise None.

    Short patterns (no edits allowed) must also start and end on word boundaries, so "NOM" is not
    found inside "PRENOMS".
    """
    if max_edits is None:
        max_edits = allowed_edits(pattern)
    if not pattern:
        return 0
    if max_edits == 0:
        return 0 if re.search(rf"(?<![A-Z0-9]){re.escape(pattern)}(?![A-Z0-9])", text) else None
    if pattern in text:
        return 0
    best = substring_distance(text, pattern)
    return best if best <= max_edits else None


def substring_distance(text: str, pattern: str) -> int:
    """Smallest edit distance between `pattern` and any substring of `text`: Myers' bit-parallel
    algorithm (one pass over the text, the pattern's columns held in the bits of an integer)."""
    m = len(pattern)
    if m == 0:
        return 0
    full = (1 << m) - 1
    top = 1 << (m - 1)
    peq: dict[str, int] = {}
    for i, ch in enumerate(pattern):
        peq[ch] = peq.get(ch, 0) | (1 << i)
    pv = full
    mv = 0
    score = m
    best = m
    for ch in text:
        eq = peq.get(ch, 0)
        xv = eq | mv
        xh = ((((eq & pv) + pv) & full) ^ pv) | eq
        ph = (mv | ~(xh | pv)) & full
        mh = pv & xh
        if ph & top:
            score += 1
        elif mh & top:
            score -= 1
        # A match may start anywhere in the text: no carry into the first row.
        ph = (ph << 1) & full
        mh = (mh << 1) & full
        pv = (mh | ~(xv | ph)) & full
        mv = ph & xv
        if score < best:
            best = score
    return best


def edit_distance_reference(text: str, pattern: str) -> int:
    """The same as substring_distance, by plain dynamic programming (Sellers); for tests."""
    m = len(pattern)
    previous = [0] * (m + 1)
    for j in range(1, m + 1):
        previous[j] = j
    best = previous[m]
    for ch in text:
        current = [0] * (m + 1)
        for j in range(1, m + 1):
            cost = 0 if pattern[j - 1] == ch else 1
            current[j] = min(previous[j - 1] + cost, previous[j] + 1, current[j - 1] + 1)
        previous = current
        best = min(best, previous[m])
    return best


def contains(text: str, pattern: str, max_edits: int | None = None) -> bool:
    return fuzzy_find(text, pattern, max_edits) is not None
