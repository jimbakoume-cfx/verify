# Gates: scratch-0.863_22490_139500

**FAIL** (automated gates; G4 is manual)

| Gate | Check | Value | Limit | Result |
|---|---|---|---|---|
| G1 | clean: CER % | 0.036 | <= 0.5 | pass |
| G1 | clean: lines exact % | 98.83 | >= 98 | pass |
| G1 | clean: CER % vs Doubango | 0.036 | <= 0.014 | fail |
| G1 | lowres: CER % | 0.61 | <= 1.0 | pass |
| G1 | lowres: CER % vs Doubango | 0.61 | <= 0.922 | pass |
| G1 | degraded: CER % | 3.982 | <= 10.0 | pass |
| G1 | degraded: CER % vs Doubango | 3.982 | <= 5.457 | pass |
| G2 | documents read | 1000 | >= 1000 | pass |
| G2 | wrong but valid, the model's own | 3 | <= 0 | fail |
| info | wrong but valid, made wrong by the correction step | 3 | - | info |
| G3 | valid and exact % | 98.8 | >= 97 | pass |
| G3 | names line exact % | 99.7 | >= 99 | pass |
| G3 | validExactRate vs Doubango | 98.8 | >= 98 | pass |
| G3 | validWrong vs Doubango | 6 | <= 5 | fail |
| fixtures | repository fixtures failed | 0 | <= 0 | pass |
| size | integer model, gzipped (bytes) | 354816 | <= 1500000 | pass |
| G4 | the PM's own photos (manual, offline) | - | see gates.json | missing |

Document benchmark by group:

| Group | n | valid exact | wrong but valid | invalid | not found | names exact | CER % | ms |
|---|---|---|---|---|---|---|---|---|
| TD1-clean | 250 | 246 | 2 | 1 | 1 | 248 | 0.413 | 296 |
| TD1-degraded | 250 | 246 | 3 | 1 | 0 | 249 | 0.018 | 290 |
| TD3-clean | 250 | 247 | 1 | 2 | 0 | 250 | 0.014 | 282 |
| TD3-degraded | 250 | 249 | 0 | 1 | 0 | 250 | 0.005 | 289 |

Native lstmeval (character error rate %, informational): int clean 0.019, int degraded 5.109, int lowres 0.968, float clean 0.019, float degraded 5.141, float lowres 0.954
