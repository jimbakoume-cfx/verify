"""Fictitious MRZ ("code lines") text for training and benchmarks.

Every line is made up: random names built from syllables and letters, random numbers and dates,
real or made-up state codes. Check digits follow ICAO 9303 (weights 7-3-1), so documents built here
parse as valid exactly like a real one would. Nothing comes from a real document.

Formats: TD1 (3 x 30, identity and residence cards), TD2 (2 x 36, only as extra line variety for
training) and TD3 (2 x 44, passports). `random_line` gives free strings over the MRZ alphabet, so
the model learns characters rather than the layout of a field.
"""

from __future__ import annotations

import random

ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
DIGITS = "0123456789"
CHARSET = ALPHA + DIGITS + "<"

# Name syllables: a mix of Cameroonian, French and English sounds, so names look like the ones the
# reader meets without copying anyone's name. Half the words are plain random letters.
SYLLABLES = [
    "BA", "BE", "BI", "BO", "BOU", "MA", "ME", "MI", "MBA", "MBE", "NA", "NE", "NGO", "NGA", "NJI",
    "NKO", "NDO", "TA", "TCHA", "TCHO", "KA", "KE", "KOU", "FO", "FA", "LE", "LA", "DOU", "DI",
    "YA", "YE", "ZE", "SA", "SI", "SOU", "RO", "RA", "PO", "PE", "GA", "GUI", "HA", "JEAN", "MARIE",
    "PAUL", "WA", "VI", "QUE", "XA", "EK", "ON", "AN", "IN", "OU", "AM", "EYE", "ESS", "ABA", "ETO",
    "OWO", "TSA", "FEU", "KAM", "TAM", "NOU", "CHRIS", "ANNE", "LUC", "ERIC", "IBRA", "HIM", "OUM",
]

# Issuing states and nationalities: Cameroon and its neighbours most often, ICAO's specimen state
# "UTO", the special codes with fillers, and random three-letter codes.
STATES = ["CMR"] * 6 + ["FRA", "NGA", "TCD", "GAB", "COG", "CAF", "GNQ", "UTO", "UTO", "BEL", "CHE",
                        "SEN", "CIV", "MLI", "USA", "GBR", "DEU", "CHN", "D<<", "XXA", "XXB", "XXC"]


def char_value(c: str) -> int:
    if c.isdigit():
        return int(c)
    if "A" <= c <= "Z":
        return ord(c) - 55
    if c == "<":
        return 0
    raise ValueError(c)


def check_digit(field: str) -> str:
    weights = (7, 3, 1)
    return str(sum(char_value(c) * weights[i % 3] for i, c in enumerate(field)) % 10)


def pad(text: str, length: int) -> str:
    """Pads with fillers, or truncates as a long name is truncated on a real document."""
    return (text + "<" * length)[:length]


class MrzText:
    """Draws fictitious MRZ lines from its own random generator (deterministic for a seed)."""

    def __init__(self, rng: random.Random):
        self.r = rng

    # -- fields -------------------------------------------------------------------------------
    def word(self) -> str:
        r = self.r
        if r.random() < 0.5:
            return "".join(r.choice(ALPHA) for _ in range(r.randint(1, 12)))
        return "".join(r.choice(SYLLABLES) for _ in range(r.randint(1, 4)))[:16]

    def names(self, length: int) -> str:
        """SURNAME<<GIVEN<NAMES, filler-padded; about one in ten fills the whole field and is cut
        short (long names are truncated, so the line ends on a letter, not a filler)."""
        r = self.r
        surname = "<".join(self.word() for _ in range(r.choice([1, 1, 1, 2, 3])))
        given = "<".join(self.word() for _ in range(r.choice([0, 1, 1, 2, 3, 4])))
        text = surname + ("<<" + given if given else "")
        if r.random() < 0.1:
            while len(text) < length + 3:
                text += "<" + self.word()
        return pad(text, length)

    def state(self) -> str:
        r = self.r
        if r.random() < 0.15:
            return "".join(r.choice(ALPHA) for _ in range(3))
        return r.choice(STATES)

    def date(self) -> str:
        """YYMMDD: mostly real calendar dates, sometimes any digits (the model must not learn that
        a month never starts with 2)."""
        r = self.r
        if r.random() < 0.1:
            return "".join(r.choice(DIGITS) for _ in range(6))
        return f"{r.randint(0, 99):02d}{r.randint(1, 12):02d}{r.randint(1, 31 if r.random() < 0.2 else 28):02d}"

    def number(self, length: int = 9) -> str:
        r = self.r
        k = r.randint(6, length)
        pool = r.choice([ALPHA + DIGITS + DIGITS, DIGITS, ALPHA + DIGITS])
        return pad("".join(r.choice(pool) for _ in range(k)), length)

    def optional(self, length: int) -> str:
        r = self.r
        if r.random() < 0.55:
            return "<" * length
        return pad("".join(r.choice(ALPHA + DIGITS) for _ in range(r.randint(1, length))), length)

    def sex(self) -> str:
        return self.r.choice("MMFF<X")

    def code(self, kind: str) -> str:
        r = self.r
        if kind == "P":
            return r.choice(["P<", "P<", "P<", "PM", "PO", "PD", "PS", "PT"])
        return r.choice(["ID", "ID", "I<", "IR", "IP", "IO", "AC", "A<", "C<", "IT", "AR", "CR"])

    # -- documents ----------------------------------------------------------------------------
    def td1(self) -> list[str]:
        r = self.r
        if r.random() < 0.05:
            # Long document number (ICAO 9303 Part 5, 4.2.4): 9 characters, a filler for the check
            # digit, the rest and the check digit of the whole number in the optional data.
            full = "".join(r.choice(ALPHA + DIGITS) for _ in range(r.randint(10, 13)))
            l1 = pad(self.code("I") + self.state() + full[:9] + "<" + full[9:] + check_digit(full), 30)
        else:
            number = self.number()
            l1 = pad(self.code("I") + self.state() + number + check_digit(number) + self.optional(15), 30)
        birth, expiry = self.date(), self.date()
        l2 = birth + check_digit(birth) + self.sex() + expiry + check_digit(expiry) + self.state() + self.optional(11)
        composite = l1[5:30] + l2[0:7] + l2[8:15] + l2[18:29]
        return [l1, l2 + check_digit(composite), self.names(30)]

    def td2(self) -> list[str]:
        number, birth, expiry, opt = self.number(), self.date(), self.date(), self.optional(7)
        l1 = self.code("I") + self.state() + self.names(31)
        l2 = (number + check_digit(number) + self.state() + birth + check_digit(birth) + self.sex()
              + expiry + check_digit(expiry) + opt)
        composite = l2[0:10] + l2[13:20] + l2[21:35]
        return [l1, l2 + check_digit(composite)]

    def td3(self) -> list[str]:
        r = self.r
        number, birth, expiry, personal = self.number(), self.date(), self.date(), self.optional(14)
        personal_digit = "<" if personal == "<" * 14 and r.random() < 0.5 else check_digit(personal)
        l1 = self.code("P") + self.state() + self.names(39)
        l2 = (number + check_digit(number) + self.state() + birth + check_digit(birth) + self.sex()
              + expiry + check_digit(expiry) + personal + personal_digit)
        composite = l2[0:10] + l2[13:20] + l2[21:43]
        return [l1, l2 + check_digit(composite)]

    def document(self, fmt: str) -> list[str]:
        return {"TD1": self.td1, "TD2": self.td2, "TD3": self.td3}[fmt]()

    def random_line(self, length: int | None = None) -> str:
        """Any characters of the alphabet, with runs of fillers as in real lines."""
        r = self.r
        n = length or r.choice([30, 36, 44])
        out: list[str] = []
        while len(out) < n:
            if r.random() < 0.22:
                out += ["<"] * r.randint(1, 8)
            else:
                out.append(r.choice(ALPHA + DIGITS))
        return "".join(out[:n])

    def line(self, random_share: float = 0.15) -> str:
        """One training line: `random_share` free strings, otherwise a line of a TD3 (35%), TD1
        (35%) or TD2 (15%) document."""
        r = self.r
        x = r.random()
        if x < random_share:
            return self.random_line()
        rest = (x - random_share) / (1 - random_share)
        fmt = "TD3" if rest < 0.41 else ("TD1" if rest < 0.82 else "TD2")
        return r.choice(self.document(fmt))


def self_test() -> None:
    """The ICAO 9303 Part 4/5 specimen check digits."""
    assert check_digit("L898902C3") == "6"
    assert check_digit("740812") == "2"
    assert check_digit("120415") == "9"
    assert check_digit("D23145890") == "7"
    gen = MrzText(random.Random(1))
    for _ in range(2000):
        for fmt, (count, length) in {"TD1": (3, 30), "TD2": (2, 36), "TD3": (2, 44)}.items():
            lines = gen.document(fmt)
            assert len(lines) == count and all(len(x) == length for x in lines), (fmt, lines)
            assert all(c in CHARSET for x in lines for c in x), lines
        assert all(c in CHARSET for c in gen.line())


if __name__ == "__main__":
    self_test()
    print("mrztext: ok")
