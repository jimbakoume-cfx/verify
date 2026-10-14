"""Applies gates.json to the measurements bin/60-gates.sh made, and writes report.json and report.md.

Exit code: 0 when every automated gate passes, 1 when one fails (or lacks the data it needs, such as
fewer benchmark documents than G2 requires). G4 (the PM's own photos) is always listed as manual.

usage: gates.py CANDIDATE_DIR BASELINE_DIR GATES_JSON MODEL_JSON|-
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def load(path: Path) -> dict | None:
    return json.loads(path.read_text()) if path.exists() else None


def main() -> None:
    cand, base, gates_path, model_path = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4]
    gates = json.loads(gates_path.read_text())
    model = json.loads(Path(model_path).read_text()) if model_path != "-" else None
    checks: list[dict] = []

    def check(gate: str, what: str, value, limit, ok: bool | None) -> None:
        result = "missing" if ok is None else ("pass" if ok else "fail")
        checks.append({"gate": gate, "check": what, "value": value, "limit": limit,
                       "result": "info" if gate == "info" else result})

    # G1: line CER per set, and never worse than the baseline on the same set.
    for name, limits in gates["G1"]["sets"].items():
        c, b = load(cand / f"g1-{name}.json"), load(base / f"g1-{name}.json")
        if c is None:
            check("G1", f"{name}: CER %", None, limits["maxCer"], None)
            continue
        check("G1", f"{name}: CER %", c["cer"], f"<= {limits['maxCer']}", c["cer"] <= limits["maxCer"])
        if "minLineExact" in limits:
            check("G1", f"{name}: lines exact %", c["lineExact"], f">= {limits['minLineExact']}", c["lineExact"] >= limits["minLineExact"])
        if gates["G1"].get("notWorseThanBaseline") and cand != base:
            # No baseline for this set (an interrupted baseline run) is "missing", never a pass.
            if b is None:
                check("G1", f"{name}: CER % vs Doubango", c["cer"], "Doubango's result", None)
            else:
                same = b["lines"] == c["lines"]
                check("G1", f"{name}: CER % vs Doubango", c["cer"], f"<= {b['cer']}", (c["cer"] <= b["cer"]) if same else None)

    # G2 and G3: the document benchmark through the rider's pipeline.
    c = load(cand / "docbench.json")
    b = load(base / f"docbench-{c['bench']['count']}.json") if c else None
    if c is None:
        check("G2", "wrong but valid", None, 0, None)
    else:
        o = c["overall"]
        enough = o["n"] >= gates["G2"]["minDocuments"]
        check("G2", "documents read", o["n"], f">= {gates['G2']['minDocuments']}", enough)
        wrong = o["validWrong"] - (0 if gates["G2"].get("countCorrectionCaused", True) else o.get("validWrongFromCorrection", 0))
        label = "wrong but valid" if gates["G2"].get("countCorrectionCaused", True) else "wrong but valid, the model's own"
        check("G2", label, wrong, f"<= {gates['G2']['maxWrongButValid']}", wrong <= gates["G2"]["maxWrongButValid"])
        # Not a gate: how many of those the OCR had read right and the look-alike correction
        # (supabase/functions/_shared/mrzCorrect.ts) turned wrong. They count against G2 all the
        # same (the rider would be told "read"), but they are not the model's doing.
        check("info", "wrong but valid, made wrong by the correction step", o.get("validWrongFromCorrection"), "-", True)
        check("G3", "valid and exact %", o["validExactRate"], f">= {gates['G3']['minValidExactRate']}", o["validExactRate"] >= gates["G3"]["minValidExactRate"])
        check("G3", "names line exact %", o["nameExactRate"], f">= {gates['G3']['minNameExactRate']}", o["nameExactRate"] >= gates["G3"]["minNameExactRate"])
        if cand != base:
            if b is None or b["bench"].get("sha256") != c["bench"].get("sha256"):
                check("G3", "same documents as the Doubango baseline", None, "present", None)
            else:
                bo = b["overall"]
                for key in gates["G3"]["notWorseThanBaseline"]:
                    better_high = key != "validWrong"
                    ok = o[key] >= bo[key] if better_high else o[key] <= bo[key]
                    check("G3", f"{key} vs Doubango", o[key], f"{'>=' if better_high else '<='} {bo[key]}", ok)

    f = load(cand / "fixtures.json")
    if f is None:
        check("fixtures", "repository fixtures", None, "6/6", None)
    else:
        failures = len(f.get("fixtureFailures", []))
        check("fixtures", "repository fixtures failed", failures, f"<= {gates['fixtures']['maxFailures']}", failures <= gates["fixtures"]["maxFailures"])

    if model is not None:
        gz = model["integerGz"]["bytes"]
        check("size", "integer model, gzipped (bytes)", gz, f"<= {gates['size']['maxGzBytes']}", gz <= gates["size"]["maxGzBytes"])
    elif cand != base:
        # A candidate without model.json cannot show its size: "missing", never a pass. (The
        # baseline, Doubango's model, is not judged on its size.)
        check("size", "integer model, gzipped (bytes)", None, f"<= {gates['size']['maxGzBytes']}", None)
    check("G4", "the PM's own photos (manual, offline)", None, "see gates.json", None)

    automated = [x for x in checks if x["gate"] not in ("G4", "info")]
    passed = all(x["result"] == "pass" for x in automated)
    lstmeval = load(cand / "lstmeval.json")
    report = {"model": model, "passed": passed, "checks": checks, "lstmeval": lstmeval,
              "docbench": c["overall"] if c else None, "docbenchGroups": c["groups"] if c else None}
    (cand / "report.json").write_text(json.dumps(report, indent=1) + "\n")

    lines = [f"# Gates: {cand.name}", "", f"**{'PASS' if passed else 'FAIL'}** (automated gates; G4 is manual)", "",
             "| Gate | Check | Value | Limit | Result |", "|---|---|---|---|---|"]
    for x in checks:
        lines.append(f"| {x['gate']} | {x['check']} | {x['value'] if x['value'] is not None else '-'} | {x['limit']} | {x['result']} |")
    if c:
        lines += ["", "Document benchmark by group:", "", "| Group | n | valid exact | wrong but valid | invalid | not found | names exact | CER % | ms |",
                  "|---|---|---|---|---|---|---|---|---|"]
        for g, t in c["groups"].items():
            lines.append(f"| {g} | {t['n']} | {t['validExact']} | {t['validWrong']} | {t['invalid']} | {t['notFound']} | {t['nameExact']} | {t['cer']} | {t['msPerStill']} |")
    if lstmeval:
        lines += ["", "Native lstmeval (character error rate %, informational): " + ", ".join(f"{k} {v}" for k, v in lstmeval.items())]
    (cand / "report.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
