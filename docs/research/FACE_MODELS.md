# Face models for M5–M7: licences, provenance, accuracy (research, 2026-10-19)

All sources below were checked on **2026-10-19**. Speeds marked "est." are our own estimates from model size and FLOPs, not measurements. This is not legal advice. Everything marked amber or red goes to the lawyer.

## 0. Bottom line

1. **No open-weight face-recognition model is clean (green).** Every model we checked was either trained on non-commercial data (MS-Celeb-1M, VGGFace2, CASIA-WebFace, WebFace260M, Glint360K, DigiFace-1M) or does not say what it was trained on.
   - The least-bad open option is **AuraFace v1** (Apache-2.0). Its authors say it was trained on "a commercial dataset", which they do not name.
   - The clean routes are paid: a **commercial licence** (InsightFace's own, or an on-premise vendor SDK) or **our own model trained on consented data**.
   - The PM has to choose (section 8).
2. **Face detection and landmarks can be green:** Google's **MediaPipe** BlazeFace and Face Landmarker. Their weights are Apache-2.0, they were trained on Google-collected data, and their model cards include a fairness evaluation that covers Middle and Western Africa.
   - **YuNet, which `PLAN.md` lists as "MIT", is actually amber.** It was trained on WIDER FACE (CC BY-NC-ND 4.0) with labels from InsightFace's SCRFD.
3. **Passive anti-spoofing has no green open model.**
   - MiniVision Silent-Face is Apache-2.0, but it does not say what it was trained on. One secondary source says CelebA-Spoof, which is non-commercial.
   - The commercially safe core is **active liveness built on landmarks** (challenge + 3D/parallax geometry), plus **our own screen and print detectors**, trained on our own attack captures.
4. **Darker skin tones: the risk is mainly false matches, not false rejects.**
   - NIST's FRTE 1:1 demographic table (updated 2025-03-05) covers 596 algorithms. At a fixed threshold, their **median false-match rate for West Africans is 13.8× the rate for Eastern Europeans**. Only about 1% of algorithms are within 2×.
   - False-non-match differences are small (about 1.3–1.6×).
   - So the decision threshold must be **calibrated on Cameroonian impostor pairs**, never taken from a model's default.

## 1. Constraints applied

These come from `PLAN.md`: §2 stack and licence warnings, M5–M7, and "Decisions for the remaining milestones".
- Every library **and** every weight file must allow commercial use. We also check the terms of the training data.
- Everything runs in-house, with no APIs.
- The worker is a Vercel Python function: 1 vCPU, 2 GB, a 500 MB bundle and 300 s, on test sessions under a daily cap. A container may come later. The worker has no PyTorch; it runs models with ONNX Runtime and OpenCV.
- Phones are low-end Android on slow networks, so in-browser models must be small.
- The models must be accurate on darker skin, and we measure it per group (§5 of the plan).
- M5 is the random head-turn and blink challenge. M6 re-checks liveness on the server and adds passive anti-spoofing. M7 matches the selfie to the ID portrait.

## 2. Face detection and alignment

| Model | Code licence | Weights licence | Training data and its terms | Size | Speed | Accuracy and demographic notes | Verdict |
|---|---|---|---|---|---|---|---|
| **MediaPipe BlazeFace** (short-range for selfies, full-range for the ID photo) | Apache-2.0 (`mediapipe` 1.1.1 on PyPI, `@mediapipe/tasks-vision` 1.1.1 on npm) | **Apache-2.0**, stated on the model card | Google's own captures "on a diverse set of" phones and conditions. Not public, but nothing suggests scraped or non-commercial data. | 230 KB short-range, 1.08 MB full-range | 2.94 ms on a Pixel 6 CPU (Google). Est. 10–30 ms on a low-end phone with wasm. | Fairness evaluation over 17 UN geographic subregions (including Middle and Western Africa), perceived gender and 5 skin-tone groups. Model card dated 2021-06-09. | **Green** |
| **MediaPipe Face Landmarker** (BlazeFace + FaceMesh V2 + Blendshapes V2; 478 3D points, 52 blendshapes including eye blinks, head-pose matrix) | Apache-2.0 | **Apache-2.0**, on each model card | Google's own data. Blendshapes were trained on "millions of samples" of lab and synthetic data. | 3.76 MB `.task` | Est. 20–60 ms per frame on a low-end phone. Server: ~41.5 MB wheel, est. 20–40 ms per frame. | Blendshape fairness: 511 lab samples, Monk skin-tone scale 1–10, subgroups within one standard deviation. Mesh fairness: 17 regions. **Out of scope per the card:** "human life-critical decisions"; landmarks "do not provide facial recognition". We use it only for geometry and liveness, which fits. | **Green** |
| OpenCV **YuNet** (`face_detection_yunet_2023mar`) | MIT (OpenCV zoo); training code BSD-3 | MIT | **WIDER FACE**, whose Hugging Face card says CC BY-NC-ND 4.0; labels "come from SCRFD" (InsightFace) | 233 KB (int8 100 KB) | Est. 5–15 ms per image on 1 vCPU | WIDER val AP 0.884 / 0.866 / 0.750 (easy/medium/hard). No demographic evaluation. | **Amber.** The licence on the weights is clean, but the training data is non-commercial. `PLAN.md` and `LICENSES.md` say only "MIT". |
| InsightFace **SCRFD**, RetinaFace | MIT | **Non-commercial** ("models trained with these data … non-commercial research purposes only") | WIDER FACE | 3–17 MB | Fast | Good | **Red** |
| Silent-Face's bundled `Widerface-RetinaFace.caffemodel` | Apache-2.0 (repo) | Apache-2.0 (repo) | WIDER FACE (as its name says) | 1.9 MB | Fast | – | **Amber.** Do not use; use MediaPipe instead. |
| dlib MMOD detector, 5-point shape predictor | Boost (dlib) | CC0 | Faces from ImageNet, AFLW, Pascal VOC, VGG, **WIDER**, FaceScrub; 5-point set scraped from the internet | ~1 MB | dlib has **no Linux wheel** (source only, 20.0.1), so it must be compiled | – | **Amber** |
| dlib 68-point predictor | Boost | CC0 on the repo, but its own note says it "can't be used in a commercial product" | iBUG 300-W (non-commercial) | 99 MB | – | – | **Red** |

**Alignment:** SFace, AuraFace and ArcFace-style models expect the standard 5-point similarity alignment to 112×112: both eyes, the nose tip and both mouth corners. Face Landmarker's mesh provides all five; BlazeFace alone has no mouth corners. So run Face Landmarker on the server on both the selfie and the ID portrait. Fall back to BlazeFace full-range if no mesh is found on a small ID portrait, and measure how often that happens.

## 3. Face recognition (selfie vs ID portrait)

| Model | Code | Weights | Training data and its terms | Size | CPU (1 vCPU, est.) | Accuracy | Demographics | Verdict |
|---|---|---|---|---|---|---|---|---|
| **AuraFace v1** (fal.ai, 2024-08-26; ArcFace recipe, ResNet-100, `glintr100.onnx`) | (InsightFace-compatible) | **Apache-2.0** | "a commercial dataset comprising face images from various sources". **Not named and much smaller than ArcFace's.** Get it in writing. | 260.7 MB | 0.5–1.5 s per face; ~1 GB RAM | LFW 99.65, CFP-FP 95.19, AgeDB 96.10, CPLFW 90.93 (ArcFace: 98.87 / 98.38 / 93.43) | Authors: "may vary on the basis of ethnicity". No published evaluation. | **Amber.** Use **only `glintr100.onnx`**; see warning below. |
| OpenCV zoo **SFace** (MobileFaceNet, `2021dec`) | Apache-2.0 | Apache-2.0 | **Not disclosed.** The SFace paper trains only on **CASIA-WebFace, VGGFace2 and MS-Celeb-1M**, all non-commercial or withdrawn. | 38.7 MB fp32; 9.9 MB int8 | ~10–20 ms | LFW 99.40 (int8bq 99.42, int8 99.32) | None published | **Amber leaning red** |
| **dlib ResNet v1** (`dlib_face_recognition_resnet_model_v1`) | Boost | CC0 | ~3M faces of ~7,485 identities: FaceScrub, VGG and **images scraped from the internet** | 22 MB + dlib compiled from source | ~50–150 ms | LFW 99.38 | `face_recognition` README: "does not work very well on children"; "accuracy may vary between ethnic groups" | **Amber leaning red.** The weights are CC0, but the data is scraped and the build is painful. |
| OpenVINO `face-reidentification-retail-0095` (MobileFaceNet) | Apache-2.0 (Open Model Zoo) | Apache-2.0 | **Not stated** | ~4 MB (1.1 M params, 0.59 GFLOPs) | ~10 ms | LFW 99.47 | None | **Amber.** Undisclosed data. |
| InsightFace **buffalo_l / antelopev2** (ArcFace) | MIT | **Non-commercial**; a **commercial licence is sold** (contact@insightface.ai, no public price) | MS1M / Glint360K / WebFace | 170–260 MB | 0.1–1.5 s | Excellent; in NIST FRTE as `insightface_000…004` | FRTE `insightface_001`: FNMR 0.0033; W. Africa / E. Europe false-match ratio 9.86 | **Red** as downloaded. **Amber** with a paid licence: the lawyer must check whether that licence covers the training-data provenance. |
| **EdgeFace** (Idiap) | BSD-3 | **CC BY-NC-SA 4.0** | WebFace260M (4M/12M subsets) | 1.2–18 M params | Fast | LFW 99.57–99.83 | – | **Red** |
| **AdaFace** | MIT | No licence stated | CASIA, VGGFace2, MS1MV2/V3, WebFace4M/12M | 18–250 MB | – | LFW up to 99.82; IJB-C 97.66 | – | **Red** |
| FaceNet (davidsandberg, `facenet-pytorch`) | MIT | Unstated or inherited | CASIA-WebFace, VGGFace2 | ~90 MB | – | LFW ~99.6 | – | **Red** |
| MagFace, ElasticFace, GhostFaceNets and similar | MIT/Apache | Inherited | MS1MV2 / Glint360K / WebFace | – | – | – | – | **Red** |
| Synthetic-only: DigiFace-1M (Microsoft) | – | – | **Research Use of Data Agreement:** models trained on it are "Results" and may not be used "in any commercial offering" | – | – | LFW 96.17 synthetic-only | – | **Red.** Ask Microsoft for a commercial licence; it is the cleanest provenance if they grant one. |
| Synthetic GAN/diffusion sets (SynFace, the "SFace" synthetic dataset, IDiff-Face, DCFace, Vec2Face, …) | – | – | The generators were trained on CASIA-WebFace / WebFace / FFHQ; the ones we found are NC (e.g. CC BY-NC-ND) | – | – | Best synthetic sets ~93–96% average accuracy (arXiv 2510.17372) | – | **Red.** We found no commercial-safe one. |
| On-premise **vendor SDK** (e.g. Paravision, Rank One (ROC), IDEMIA, Innovatrics) | Commercial | Commercial contract | Vendor's responsibility; ask for a written warranty | Varies | Varies | Top of FRTE: FNMR ~0.0016–0.0019 | W. Africa / E. Europe ratio: **paravision_017 0.81, roc_015 1.95, idemia_011 2.01** (FRTE table, 2025-03-05) | **Green licence-wise**, but it contradicts "no KYC vendors" and costs money (PM decision) |

**Warnings on AuraFace (we verified both on 2026-10-19):**
- **Copied InsightFace files.** The `fal/AuraFace-v1` repo also ships `scrfd_10g_bnkps.onnx`, `2d106det.onnx`, `1k3d68.onnx` and `genderage.onnx`. Their SHA-256 hashes are **byte-identical to InsightFace's non-commercial `antelopev2` files**, yet they appear under the Apache-2.0 label. Never use those four files. AuraFace's `glintr100.onnx` hash *differs* from antelopev2's, so it was retrained, as claimed.
- **Trust.** The careless relicensing lowers our trust in the "commercial dataset" claim. Ask fal.ai for the dataset's name, its licence and the consent basis before relying on it.

**Demographic evidence that exists:**
- **NIST FRTE 1:1 demographics** (https://pages.nist.gov/frvt/html/frvt_demographics.html, table updated 2025-03-05, 597 algorithms):
  - At a threshold set for an overall false-match rate (FMR) of 3e-5, the highest FMR for most algorithms is in **West African women aged 65 and over**.
  - The median W. Africa / E. Europe FMR ratio is 13.8.
  - FNMR differentials are small: the worst group is often W. Africa, at about 1.3–1.6× the best.
  - None of our open candidates except InsightFace was submitted to NIST. OpenFace (the old open-source model, `openface_001`) shows a ratio of 67.7.
- **NISTIR 8280** (2019-12): false positives are "highest in West and East African and East Asian people"; the difference across countries is often "a factor of 100".
- **NIST's own warning:** under-exposure of dark-skinned subjects raises false non-matches. This is our capture-quality problem (M1/M5 exposure hints).
- **RFW** (Wang et al., ICCV 2019, https://openaccess.thecvf.com/content_ICCV_2019/papers/Wang_Racial_Faces_in_the_Wild_Reducing_Racial_Bias_by_Information_ICCV_2019_paper.pdf): ArcFace trained on CASIA scored 92.15% on Caucasian faces and **84.93% on African faces**; "error rates on African faces are about two times of Caucasians".
  - RFW is built from MS-Celeb-1M, so **we should not use RFW ourselves** commercially, even for testing.
- **Our case is hard in another way too.** A selfie against a small, printed, laminated ID portrait, possibly years old, is harder than LFW. No public number covers Cameroonian CNI portraits. **Our own consented test set is the only valid measure.**

### Training our own model (what it would take)
- **Data, with commercial rights:**
  - (a) Consented riders, if the consent text allows training: each case gives an ID portrait plus several selfie frames, which is exactly our domain. At under 500 signups a day, ~10k identities takes about 1–3 months, ~50k about a year.
  - (b) Bought datasets with commercial licences and documented consent. Several data vendors sell these; check African representation and the contract.
  - (c) A commercial licence to DigiFace-1M or a similar rendered set.
  - A model trained from zero on about 10k identities reaches roughly 92–97% on LFW-style tests. Pre-training on a licensed synthetic set and then fine-tuning on (a) is the published recipe: DigiFace reaches near real-data accuracy with a few thousand consented identities.
- **Compute:** a MobileFaceNet or ResNet-50 with ArcFace loss on 1M images takes about 1–3 GPU-days, roughly US$100–500 of rented GPU per run. Training code: InsightFace's (MIT) or our own.
- **People and time:** about 4–8 weeks of ML work after the data exists, plus a demographic evaluation harness. It cannot happen before the pilot unless (b) or (c) is bought.
- **Legal:** training on rider faces is a separate processing purpose. It needs its own consent wording, retention rules and a DPIA entry (Q3/Q4).

## 4. Anti-spoofing (presentation attacks) and liveness

| Option | Code | Weights | Training data | Size and speed | Accuracy | Verdict |
|---|---|---|---|---|---|---|
| **MiniVision Silent-Face** (MiniFASNetV1SE + V2, fused) | **Apache-2.0** (LICENSE in the repo; last commit 2020-08-05) | Apache-2.0 (in the repo) | **Not disclosed.** A secondary source (axonlab.ai, 2026-04) says CelebA-Spoof (**non-commercial**) plus proprietary data; unverified. Their more accurate model is closed ("未开源", not open-sourced). | 2 × 1.9 MB `.pth`, 0.08 GFLOPs each. PyTorch only, so **export to ONNX** (no torch on Vercel). Est. under 20 ms on the server. | Claims TPR 97.8% at FPR 1e-5 on an unnamed set. The README warns that robustness is limited across camera models and scenes. | **Amber.** Use as a low-weight signal on test sessions only; measure on our own attacks. |
| Intel `anti-spoof-mn3`, AENet, DeepPixBiS, CDCN, IADG… | Various | Various | CelebA-Spoof ("**non-commercial research purposes only**"), OULU-NPU, SiW, Replay-Attack, CASIA-FASD (all research-only) | – | – | **Red** |
| **Our own replay and print signals** (screen moiré via FFT, pixel grid, bezel and edge detection, glare, colour-texture LBP; scikit-learn) | Ours | Ours | **Our own consented attack captures** (fraud matrix, §5 of the plan) | Tiny, under 50 ms | Unknown until measured (APCER/BPCER) | **Green.** Shares work with M11. |
| **Active liveness from landmarks** (M5 challenge, re-checked on the server in M6) | Apache-2.0 (MediaPipe) | Apache-2.0 | – | Face Landmarker per frame | See below | **Green** |

**What landmarks alone can do (all checked on the server from the uploaded frames, never trusting the phone):**
1. **Do the requested actions in order and on time.**
   - Head turn: yaw from the face transformation matrix or from the 3D mesh.
   - Blink: `eyeBlinkLeft` and `eyeBlinkRight` blendshapes, or the eye aspect ratio from the mesh.
   - Optionally a smile or an open mouth.
   - This defeats a static photo and most pre-recorded videos, because the challenge is random and bound to a one-time code.
2. **Geometry (parallax) test.**
   - During a head turn, the 2D landmarks of a flat photo or screen follow a single **homography**, so the residual is near zero.
   - A real 3D face does not, so its residual is large: the nose moves against the cheeks, and the ear-side points disappear.
   - The mesh's z-depth must also change consistently with the turn.
   - This catches flat prints and screens, even when someone moves them; it is weaker against a curved print.
3. **Consistency checks.**
   - The same face throughout: an embedding distance between frames, or mesh-shape stability.
   - The inter-eye distance changes smoothly, with no cuts or jumps.
   - Frame timing fits the challenge.
   - Exactly one face is present.
4. **What it cannot catch alone:** realistic 3D masks; **real-time face reenactment or deepfakes fed through a virtual camera or injected stream** (an injection attack, covered by CEN/TS 18099 rather than ISO 30107-3); and a live accomplice doing the challenge while the fraudster holds someone else's ID. Face match handles the last. Injection needs device and stream signals (THREAT_MODEL item 7).

## 5. Fit with the Vercel worker
- **Bundle size:**
  - The current worker has OpenCV headless, RapidOCR and ONNX Runtime (~24 MB wheel).
  - Adding MediaPipe (~42 MB wheel; or the LiteRT runtime ~22 MB with the raw `.tflite`), Silent-Face ONNX (~4 MB) and SFace (~10–39 MB) fits easily.
  - AuraFace (261 MB) probably fits under 500 MB but is tight; **check the built size** first. In a container, size does not matter.
- **Time and memory:** one face match with AuraFace is est. 0.5–1.5 s and ~1 GB on 1 vCPU, inside 300 s and 2 GB. 8–15 liveness frames × Face Landmarker is est. under 1 s.
- **Phone:** Face Landmarker is 3.8 MB, a one-time download that the service worker should cache. On slow networks, send only the 8–15 chosen frames (JPEG ~30–60 KB each), not video.

## 6. Recommendation

| Need | Primary | Fallback |
|---|---|---|
| Face detection and landmarks, on the phone (M5 guidance) and the server (M6 re-check, M7 alignment) | **MediaPipe Face Landmarker + BlazeFace** (green) | YuNet (amber), only if the lawyer accepts WIDER FACE provenance. Otherwise BlazeFace full-range alone for small ID portraits. |
| Liveness | **Active challenge re-checked on the server: actions + parallax/homography test + consistency** (green) | Stricter challenge (3 actions) and more staff review |
| Passive anti-spoofing | **Our own screen and print signals trained on our attack captures** (green), with **Silent-Face via ONNX as a low-weight amber signal on test sessions** | Without Silent-Face: our signals plus staff review of every flagged case |
| Face match | **No green open model exists.** For test sessions: benchmark **AuraFace `glintr100.onnx`** (amber; best accuracy; disclosed as commercially trained) against **SFace** (amber/red; tiny). Ship the better one *for test sessions only*. Every face decision is advisory to a reviewer. The threshold is set on Cameroonian impostor pairs. | **Before the pilot, one of:** (a) commercial licence from InsightFace for `buffalo_l` (measured by NIST); (b) on-premise vendor SDK with good FRTE West-Africa numbers (Paravision / ROC / IDEMIA); (c) our own model (§3), pre-trained on a commercially licensed set and fine-tuned on consented riders. |

**Keep the model replaceable:** M7 stores `model_id` and version with every score. Thresholds sit in `threshold_config` per model. Templates (if Q4 is approved) are tied to a model and re-computed when it changes.

**Measure before trusting:** 50–100 consented volunteers (§5 of the plan). Report FNMR and FMR (and APCER/BPCER for anti-spoofing) **by skin tone (Monk scale), sex, age and phone**. Impostor pairs are **same-sex, same-age-band Cameroonians**, because NIST shows that this is where false matches rise.

## 7. Risks for the lawyer's list
1. **Training-data provenance of face weights.** Every open face-recognition weight was trained on scraped or non-commercial datasets (MS-Celeb-1M, VGGFace2, CASIA-WebFace, WebFace260M, Glint360K) or does not disclose its data (SFace, AuraFace, OpenVINO, Silent-Face). An Apache, MIT or CC0 label on the weights may not cure claims from the dataset licences or the people photographed (GDPR-style biometric rules, BIPA-type claims, Cameroon Law 2024-017 on personal data).
2. **AuraFace**:
   - "Commercial dataset" is undocumented. Ask fal.ai for written provenance and possibly a warranty.
   - Its repo redistributes InsightFace's non-commercial files under Apache-2.0 (verified by SHA-256). We must never ship those four files.
3. **YuNet, and our own `LICENSES.md`.** It is listed as "MIT", but its training data is WIDER FACE (CC BY-NC-ND 4.0) with SCRFD labels. Replace it with MediaPipe, or accept it explicitly.
4. **SFace / dlib** (already in `PLAN.md` as candidates): the weights are permissive, but the training data is non-commercial (SFace's paper datasets) or scraped (dlib).
5. **Silent-Face:** undisclosed training data, possibly CelebA-Spoof (non-commercial). The repo has not changed since 2020.
6. **MediaPipe model cards** exclude "human life-critical decisions" and identification. KYC is neither, but the lawyer should confirm our use (liveness geometry only) fits.
7. **Commercial licences** (InsightFace, a vendor SDK, DigiFace): does the licence cover training-data claims (indemnity)? Data stays on our systems, but check audit and telemetry clauses.
8. **Training on rider data:** a separate purpose. It needs consent wording, retention rules, an opt-out and a DPIA entry. Templates are biometric data (Q4).
9. **Bias:**
   - Documented higher false-match rates for West Africans in NIST data.
   - The process needs human review of face decisions, a per-group accuracy report before automation, and an appeal route (M10).
10. **Evaluation datasets:** RFW, LFW and the like are non-commercial. Using them even for testing a commercial product is a grey zone, so we rely on our own consented set.

## 8. Decisions for the PM
1. **Face-match route before the pilot:**
   - (a) AuraFace if fal.ai documents its data and the lawyer accepts it. Free, amber.
   - (b) Buy a commercial licence from InsightFace. Price unknown.
   - (c) An on-premise vendor SDK. Paid, and it bends the "no KYC vendors" rule, but everything stays in-house and NIST demographic results are published.
   - (d) Train our own. About 2 months of work once data exists, and needs bought or consented data.
   - Recommended: (a) for test sessions now. In parallel, get quotes for (b) and (c), and add training consent (d) to the volunteer form.
2. **May test sessions use an amber model** (AuraFace or SFace, and Silent-Face) while all face decisions are human-confirmed? Recommended: yes, test sessions only, recorded in `LICENSES.md` as exceptions.
3. **Replace YuNet with MediaPipe** in the stack table. Recommended: yes.
4. **Should the volunteer and rider consent allow using face images to train and evaluate our models?** This needs the lawyer.
5. **Automation bar:** no automatic face approval until per-skin-tone FMR and FNMR on our set meet a target. Proposal: FMR ≤ 1e-3 in every group at the chosen threshold, with a W. Africa / overall ratio ≤ 2. Q1 and Q4 interact with this.
6. **Budget** for a container host if AuraFace or a vendor SDK outgrows Vercel's bundle.

## Sources (all accessed 2026-10-19)
- PLAN.md (this repo): §2 stack and licence warnings; M5–M7; decisions dated 2026-10-16.
- OpenCV zoo SFace: https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface · file sizes: https://huggingface.co/opencv/face_recognition_sface · LFW eval: https://github.com/opencv/opencv_zoo/blob/main/tools/eval/README.md · int8 issue: https://github.com/opencv/opencv_zoo/issues/189
- SFace paper and datasets: https://github.com/zhongyy/SFace · https://arxiv.org/abs/2205.12010
- YuNet: https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet · training: https://github.com/ShiqiYu/libfacedetection.train
- WIDER FACE licence: https://huggingface.co/datasets/CUHK-CSE/wider_face
- MediaPipe: https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker · https://developers.google.com/edge/mediapipe/solutions/vision/face_detector
- MediaPipe model cards: [BlazeFace short range](https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20(Short%20Range).pdf) · [Face Mesh V2](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf) · [Blendshape V2](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Blendshape%20V2.pdf)
- InsightFace licence: https://github.com/deepinsight/insightface (README) · commercial licensing: https://www.insightface.ai/services/models-commercial-licensing
- AuraFace: https://huggingface.co/fal/AuraFace-v1 · https://huggingface.co/blog/isidentical/auraface · hashes compared against https://huggingface.co/DIAMONIK7777/antelopev2 through the HF API
- EdgeFace: https://huggingface.co/Idiap/EdgeFace-Base · https://github.com/otroshi/edgeface
- AdaFace: https://github.com/mk-minchul/AdaFace
- dlib models: https://github.com/davisking/dlib-models · caveats: https://github.com/ageitgey/face_recognition · PyPI dlib 20.0.1 (sdist only)
- OpenVINO face-reidentification-retail-0095: https://github.com/openvinotoolkit/open_model_zoo/tree/master/models/intel/face-reidentification-retail-0095
- DigiFace-1M: https://github.com/microsoft/DigiFace1M (licence: R-UDA) · https://arxiv.org/abs/2210.02579
- Synthetic-data survey: https://arxiv.org/abs/2510.17372
- Silent-Face: https://github.com/minivision-ai/Silent-Face-Anti-Spoofing (README_EN, LICENSE, `resources/`)
- CelebA-Spoof terms: https://github.com/ZhangYuanhan-AI/CelebA-Spoof
- Liveness survey (secondary; it sells datasets): https://axonlab.ai/best-open-source-face-liveness-detection-models/
- NIST FRTE demographics (table 2025-03-05): https://pages.nist.gov/frvt/html/frvt_demographics.html · NISTIR 8280: https://nvlpubs.nist.gov/nistpubs/ir/2019/NIST.IR.8280.pdf · NISTIR 8429 (2022), linked from the same page
- RFW: https://arxiv.org/abs/1812.00194 · ICCV paper linked above
- Cameroon Law No. 2024/017 of 23 December 2024 (personal data; Art. 32 on transfers abroad): https://www.dlapiperdataprotection.com/?c=CM&t=law · https://lexafrica.com/2025/10/cameroon-data-protection-law-compliance/
