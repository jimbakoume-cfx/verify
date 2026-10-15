# Gates: Doubango (mrz-1), the baseline: 600/919/980 G1 lines, first 200 benchmark documents

**FAIL** (automated gates; G4 is manual)

| Gate | Check | Value | Limit | Result |
|---|---|---|---|---|
| G1 | clean: CER % | 0.014 | <= 0.5 | pass |
| G1 | clean: lines exact % | 99.5 | >= 98 | pass |
| G1 | lowres: CER % | 0.922 | <= 1.0 | pass |
| G1 | degraded: CER % | 5.457 | <= 10.0 | pass |
| G2 | documents read | 200 | >= 1000 | fail |
| G2 | wrong but valid | 1 | <= 0 | fail |
| info | wrong but valid, made wrong by the correction step | 1 | - | info |
| G3 | valid and exact % | 98 | >= 97 | pass |
| G3 | names line exact % | 100 | >= 99 | pass |
| fixtures | repository fixtures failed | 0 | <= 0 | pass |
| G4 | the PM's own photos (manual, offline) | - | see gates.json | missing |

Document benchmark by group:

| Group | n | valid exact | wrong but valid | invalid | not found | names exact | CER % | ms |
|---|---|---|---|---|---|---|---|---|
| TD1-clean | 50 | 49 | 1 | 0 | 0 | 50 | 0.022 | 438 |
| TD1-degraded | 50 | 50 | 0 | 0 | 0 | 50 | 0 | 410 |
| TD3-clean | 50 | 47 | 0 | 3 | 0 | 50 | 0.136 | 424 |
| TD3-degraded | 50 | 50 | 0 | 0 | 0 | 50 | 0 | 423 |

Native lstmeval (character error rate %, informational): int clean 0.019, int degraded 7.822, int lowres 1.395
