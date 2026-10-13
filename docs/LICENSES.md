# Licence register

**Rule:** every library, model, font and asset used by Confiance Verify must allow **commercial use**. Software released "for research / non-commercial use only" is never allowed.

**Automatic check:** CI runs `npm run licenses` (`scripts/check-licenses.mjs`). It fails the build if *any* npm package, direct or indirect, has a licence outside the allowlist. A Python licence check will be added with the AI worker (M3).

**Allowed:** MIT, ISC, 0BSD, BSD-2/3-Clause, Apache-2.0, Unlicense, CC0-1.0, BlueOak-1.0.0, Python-2.0, Zlib. MPL-2.0 is also allowed: it is "file-level copyleft", meaning we would only have to publish changes made to those files.

**Forbidden:** GPL, AGPL, SSPL, BUSL, any "non-commercial" / "research-only" licence (e.g. CC BY-NC), and any unknown licence.

## In use now (M0)

| Component | Version | Licence | Where it runs | Source |
|---|---|---|---|---|
| React, React DOM | 19.3.0 | MIT | Web apps | npmjs.com/package/react |
| i18next | 26.4.2 | MIT | Web apps (FR/EN) | npmjs.com/package/i18next |
| react-i18next | 17.0.15 | MIT | Web apps | npmjs.com/package/react-i18next |
| @supabase/supabase-js | 2.117.2 | MIT | Web apps | npmjs.com/package/@supabase/supabase-js |
| Vite | 8.3.1 | MIT | Build only | npmjs.com/package/vite |
| @vitejs/plugin-react | 6.1.1 | MIT | Build only | npmjs.com/package/@vitejs/plugin-react |
| TypeScript | 6.0.3 | Apache-2.0 | Build only | npmjs.com/package/typescript |
| Vitest | 5.0.2 | MIT | Tests only | npmjs.com/package/vitest |
| lightningcss (dependency of Vite) | (lockfile) | MPL-2.0 | Build only; never shipped to users | npmjs.com/package/lightningcss |
| gitleaks | 8.29.1 | MIT | CI secret scan only | github.com/gitleaks/gitleaks |
| PostgreSQL | 16 (CI) / 17 (Supabase) | PostgreSQL Licence | Database | postgresql.org |
| Supabase platform | hosted | Apache-2.0 (open source; also self-hostable) | Backend | github.com/supabase/supabase |
| Confiance logo (`packages/shared/assets/*.svg`) | — | Confiance property | Web apps | Confiance Kiosk console |

The full list of every indirect npm package and its licence is in `package-lock.json`, and is checked on every CI run.

## Planned (to be verified and recorded when added)

| Component | Milestone | Expected licence | Status / caveat |
|---|---|---|---|
| tesseract.js + OCR-B trained data | M2 | Apache-2.0 | **Check the OCR-B model's licence before use** |
| Python 3.12, OpenCV, NumPy, Pillow, ONNX Runtime | M3 | PSF, Apache-2.0, BSD-3, HPND, MIT | — |
| RapidOCR + PP-OCR models | M3 | Apache-2.0 (code and models) | — |
| OpenCV YuNet face detector | M5 | MIT | — |
| MediaPipe Face Landmarker | M5 | Apache-2.0 | — |
| MiniVision Silent-Face-Anti-Spoofing | M6 | Apache-2.0 | — |
| OpenCV SFace / dlib ResNet face recognition | M7 | Apache-2.0 / public domain (CC0) | **The lawyer must review the provenance of the training data.** Benchmark on Cameroonian faces before use. |
| scikit-learn | Phase 2 | BSD-3-Clause | — |

## Rejected on purpose

| Component | Licence | Why rejected |
|---|---|---|
| Ultralytics YOLO (v5/v8/v11…) | AGPL-3.0 | Copyleft would force us to publish our service code, or buy an enterprise licence |
| InsightFace / ArcFace pretrained models (buffalo_l etc.) | Non-commercial | Not allowed for commercial use |
| `mrz` (Python) | GPL-3.0 | We write our own ICAO 9303 MRZ parser instead |
| MinIO | AGPL-3.0 | Supabase Storage is used instead |
| Redis ≥ 7.4 | RSAL/SSPL (AGPL option from 8.0) | Not needed: the job queue runs inside Postgres (Supabase Queues) |
| HashiCorp Vault | BUSL-1.1 | Supabase Vault is used instead (OpenBao if we self-host) |
