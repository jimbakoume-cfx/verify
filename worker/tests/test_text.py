"""Normalisation and fuzzy matching (keywords and labels)."""

from __future__ import annotations

import random

import pytest

from verify_worker.text import allowed_edits, contains, edit_distance_reference, normalize, substring_distance


def test_normalize():
    assert normalize("Date d'expiration / Date of expiry") == "DATE D EXPIRATION DATE OF EXPIRY"
    assert normalize("RÉPUBLIQUE DU CAMEROUN") == "REPUBLIQUE DU CAMEROUN"
    assert normalize("Nº  de carte:") == "NO DE CARTE"
    assert normalize("Œuvre") == "OEUVRE"


def test_allowed_edits_grow_with_length():
    assert [allowed_edits(w) for w in ("SEX", "NOMS", "ELECAM", "PASSEPORT", "NATIONALITE", "DATE OF BIRTH")] == [0, 0, 1, 1, 1, 2]


def test_myers_matches_dynamic_programming():
    rng = random.Random(7)
    alphabet = "ABCDE "
    for _ in range(3000):
        text = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 40)))
        pattern = "".join(rng.choice(alphabet) for _ in range(rng.randint(1, 20)))
        assert substring_distance(text, pattern) == edit_distance_reference(text, pattern)


@pytest.mark.parametrize(
    "text, pattern, found",
    [
        ("CARTE NATIONALE D IDENTITE", "CARTE NATIONALE D IDENTITE", True),
        ("CARTE NATI0NALE D IDENTlTE", "CARTE NATIONALE D IDENTITE", True),  # two wrong characters
        ("CARTE NAT0NALE D 1DENTLTE", "CARTE NATIONALE D IDENTITE", False),  # four
        ("PASSPORT", "PASSEPORT", True),  # one missing letter
        ("PRENOMS GIVEN NAMES", "NOM", False),  # short words only as whole words
        ("NOM SURNAME", "NOM", True),
        ("SEXE SEX", "SEX", True),
        ("SEXE", "SEX", False),
        ("ELECAN", "ELECAM", True),
        ("ELECTRIC", "ELECAM", False),
        ("CARTE NATIONALE D IDENTITE", "NATIONALITE", False),  # two edits from NATIONALE
        ("NATIONALITE NATIONALITY", "NATIONALITE", True),
    ],
)
def test_contains(text, pattern, found):
    assert contains(text, pattern) is found
