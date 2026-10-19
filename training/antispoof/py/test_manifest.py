"""Rules of the attack-capture manifest (standard library only: run in CI with python3 -m unittest)."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import manifest as m  # noqa: E402


def row(**overrides) -> str:
    value = {"file": "captures/0001/frame-03.jpg", "label": "screen", "person": "v017", "session": "s0042",
             "device": "tecno-spark-10", "lighting": "indoor-dim", "monk": 8, "consent": "volunteer-form-v1:v017"}
    value.update(overrides)
    return json.dumps(value)


class ManifestTest(unittest.TestCase):
    def test_a_good_row(self):
        self.assertEqual(m.parse_line(row()).label, "screen")

    def test_every_row_rests_on_a_consent(self):
        for consent in ("", "none", "volunteer-form:v017"):
            with self.assertRaises(ValueError):
                m.parse_line(row(consent=consent))
        self.assertEqual(m.parse_line(row(consent="rider-keep-faces:9f1c")).consent, "rider-keep-faces:9f1c")

    def test_pseudonyms_only_never_names(self):
        for person in ("Jean Dupont", "JEAN", "", "v017 "):
            with self.assertRaises(ValueError):
                m.parse_line(row(person=person))

    def test_no_extra_field_such_as_a_document_number(self):
        value = json.loads(row())
        value["documentNumber"] = "X"
        with self.assertRaises(ValueError):
            m.parse_line(json.dumps(value))

    def test_paths_stay_inside_the_capture_folder(self):
        for path in ("/etc/passwd", "captures/../../x.jpg"):
            with self.assertRaises(ValueError):
                m.parse_line(row(file=path))

    def test_monk_scale(self):
        for monk in (0, 11, True, "8"):
            with self.assertRaises(ValueError):
                m.parse_line(row(monk=monk))

    def test_split_by_person_keeps_each_person_on_one_side(self):
        rows = [m.parse_line(row(person=f"v{p:03d}", session=f"s{f:03d}")) for p in range(40) for f in range(3)]
        train, test = m.split_by_person(rows)
        self.assertFalse({r.person for r in train} & {r.person for r in test})
        self.assertTrue(train and test)
        self.assertEqual(m.split_by_person(rows), (train, test))

    def test_readiness_refuses_too_little_data(self):
        rows = [m.parse_line(row(person=f"v{p:03d}", label="bonafide", monk=3)) for p in range(10)]
        problems = m.readiness(rows)
        self.assertTrue(any("people" in p for p in problems))
        self.assertTrue(any("Monk" in p for p in problems))

    def test_apcer_bpcer(self):
        rows = [m.parse_line(row(label=label, person=f"v{i:03d}")) for i, label in enumerate(["screen", "screen", "bonafide", "bonafide"])]
        self.assertEqual(m.apcer_bpcer(rows, [True, False, False, True]), {"APCER.screen": 0.5, "BPCER": 0.5})


if __name__ == "__main__":
    unittest.main()
