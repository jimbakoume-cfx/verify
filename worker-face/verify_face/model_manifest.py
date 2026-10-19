"""The model files the face worker uses: where each comes from, its exact size and SHA-256.

Standard library only: scripts/fetch_models.py imports it at build time, before any dependency is
installed. The files are not in git (AuraFace alone is 261 MB); they are downloaded at build time from
these pinned URLs and refused unless their SHA-256 matches. models.py checks them again when it loads.

AuraFace (fal.ai, Apache-2.0) ships five files. Only `glintr100.onnx` is AuraFace's own, retrained
model: the four others (`scrfd_10g_bnkps.onnx`, `2d106det.onnx`, `1k3d68.onnx`, `genderage.onnx`) are
byte for byte InsightFace's non-commercial antelopev2 files, relabelled (docs/research/FACE_MODELS.md).
They are never downloaded, and FORBIDDEN_SHA256 makes sure that neither they nor InsightFace's own
`glintr100.onnx` can ever be loaded in place of a model here.
"""

from __future__ import annotations

MODELS: dict[str, dict[str, object]] = {
    # MediaPipe Face Landmarker v1 (float16): BlazeFace short-range, Face Mesh V2, Blendshapes V2, and
    # the canonical face's geometry. Apache-2.0 (model cards: storage.googleapis.com/mediapipe-assets).
    "face_landmarker.task": {
        "url": "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        "sha256": "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
        "size": 3758596,
        "licence": "Apache-2.0",
    },
    # AuraFace v1 (fal.ai, 2024-08-26), its retrained ResNet-100 recognition model only. Pinned to the
    # repository's commit af6d057c9b0ec4071d4c49c80e3539258798b609. Apache-2.0; trained on "a commercial
    # dataset" its authors do not name (amber: test sessions only, see docs/LICENSES.md).
    "glintr100.onnx": {
        "url": "https://huggingface.co/fal/AuraFace-v1/resolve/af6d057c9b0ec4071d4c49c80e3539258798b609/glintr100.onnx",
        "sha256": "a7933ea5330113b01c9b60351d8f4c33003f145d8470ac5f0e52ee2effe25c60",
        "size": 260694151,
        "licence": "Apache-2.0",
    },
}

# The members of face_landmarker.task the worker reads (the archive's other member, the geometry
# metadata, is reproduced in verify_face/data/canonical_face.json).
LANDMARKER_MEMBERS = ("face_detector.tflite", "face_landmarks_detector.tflite", "face_blendshapes.tflite")

# Files that must never be loaded, whatever they are called: InsightFace's antelopev2 pack, which is
# non-commercial (its five files' SHA-256, as published in the DIAMONIK7777/antelopev2 mirror and, for
# the first four, also inside fal/AuraFace-v1; compared through the Hugging Face API on 2026-10-19).
FORBIDDEN_SHA256 = {
    "4ab1d6435d639628a6f3e5008dd4f929edf4c4124b1a7169e1048f9fef534cdf": "InsightFace antelopev2 glintr100.onnx",
    "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91": "InsightFace scrfd_10g_bnkps.onnx (in AuraFace-v1)",
    "f001b856447c413801ef5c42091ed0cd516fcd21f2d6b79635b1e733a7109dbf": "InsightFace 2d106det.onnx (in AuraFace-v1)",
    "df5c06b8a0c12e422b2ed8947b8869faa4105387f199c477af038aa01f9a45cc": "InsightFace 1k3d68.onnx (in AuraFace-v1)",
    "4fde69b1c810857b88c64a335084f1c3fe8f01246c9a191b48c7bb756d6652fb": "InsightFace genderage.onnx (in AuraFace-v1)",
}

# Every pinned hash must differ from the forbidden ones (checked here, at import, and by the tests).
assert not set(m["sha256"] for m in MODELS.values()) & set(FORBIDDEN_SHA256), "a pinned model is a forbidden file"
