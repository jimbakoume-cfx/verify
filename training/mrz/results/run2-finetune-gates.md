# Gates: finetune-0.428_1526_18300

**PASS** (automated gates; G4 is manual)

| Gate | Check | Value | Limit | Result |
|---|---|---|---|---|
| G1 | clean: CER % | 0 | <= 0.5 | pass |
| G1 | clean: lines exact % | 100 | >= 98 | pass |
| G1 | clean: CER % vs Doubango | 0 | <= 0.014 | pass |
| G1 | lowres: CER % | 0.512 | <= 1.0 | pass |
| G1 | lowres: CER % vs Doubango | 0.512 | <= 0.922 | pass |
| G1 | degraded: CER % | 3.16 | <= 10.0 | pass |
| G1 | degraded: CER % vs Doubango | 3.16 | <= 5.457 | pass |
| G2 | documents read | 1000 | >= 1000 | pass |
| G2 | wrong but valid, the model's own | 0 | <= 0 | pass |
| info | wrong but valid, made wrong by the correction step | 3 | - | info |
| G3 | valid and exact % | 99.6 | >= 97 | pass |
| G3 | names line exact % | 99.9 | >= 99 | pass |
| G3 | validExactRate vs Doubango | 99.6 | >= 98 | pass |
| G3 | validWrong vs Doubango | 3 | <= 5 | pass |
| fixtures | repository fixtures failed | 0 | <= 0 | pass |
| size | integer model, gzipped (bytes) | 1299528 | <= 1500000 | pass |
| G4 | the PM's own photos (manual, offline) | - | see gates.json | missing |

Document benchmark by group:

| Group | n | valid exact | wrong but valid | invalid | not found | names exact | CER % | ms |
|---|---|---|---|---|---|---|---|---|
| TD1-clean | 250 | 248 | 1 | 0 | 1 | 249 | 0.404 | 431 |
| TD1-degraded | 250 | 248 | 2 | 0 | 0 | 250 | 0.009 | 426 |
| TD3-clean | 250 | 250 | 0 | 0 | 0 | 250 | 0 | 414 |
| TD3-degraded | 250 | 250 | 0 | 0 | 0 | 250 | 0 | 413 |

Native lstmeval (character error rate %, informational): int clean 0.0, int degraded 3.911, int lowres 0.776, float clean 0.0, float degraded 3.953, float lowres 0.791
