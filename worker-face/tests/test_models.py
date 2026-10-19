"""The real models (marked `models`: skipped until scripts/fetch_models.py has run) on drawn faces
(synthface.py, no real person): detection, pose signs end to end, blink, smile, the flat-plane test
against a tilted print, moire on a filmed screen, a whole liveness job and face matches on a SPECIMEN
document. CPU time per job is reported at the end of the run, never asserted."""

from __future__ import annotations

import time
import uuid

import numpy as np
import pytest

import synthface as sf
from conftest import SPECIMENS, TIMINGS
from verify_face import geometry, liveness, models, pipeline
from verify_face.imaging import decode_input

pytestmark = pytest.mark.models

# The rider app's schedule (M5): 1 frame before the actions, then 4 during each.
STEPS = [0] + [1] * 4 + [2] * 4 + [3] * 4
PASSPORT_PORTRAIT_BOX = (98, 197, 285, 356)


@pytest.fixture(scope="module")
def landmarker():
    models.reset()
    lm, _ = models.landmarker()
    return lm


def main_face(lm, picture):
    faces = lm.faces(picture)
    assert len(faces) == 1
    return faces[0]


def action_frames(action: str, person=sf.ALICE) -> list[np.ndarray]:
    """4 frames of one action, as a rider would do it (to their own left: positive yaw)."""
    if action == "turn_left":
        return [sf.render(person, yaw=y) for y in (6, 14, 22, 25)]
    if action == "turn_right":
        return [sf.render(person, yaw=-y) for y in (6, 14, 22, 25)]
    if action == "look_up":
        return [sf.render(person, pitch=p) for p in (4, 9, 14, 16)]
    if action == "blink":
        return [sf.render(person), sf.render(person, eyes_closed=True), sf.render(person), sf.render(person)]
    return [sf.render(person, smile=s) for s in (0.3, 0.7, 1.0, 1.0)]


def sequence(actions: tuple[str, ...], person=sf.ALICE) -> list[np.ndarray]:
    frames = [sf.render(person)]
    for action in actions:
        frames += action_frames(action, person)
    return frames


def claim_for(kind: str, frames: list[np.ndarray], document: np.ndarray | None = None, actions=("turn_left", "blink", "smile")):
    """A claim and its decoded inputs, the frames going through JPEG as the phone sends them."""
    inputs, images = [], {}
    for i, picture in enumerate(frames):
        data = sf.jpeg(picture)
        cid = str(uuid.uuid4())
        item = {"captureId": cid, "role": "frame", "index": i, "step": STEPS[i], "atMs": 900 + i * 600,
                "sha256": __import__("hashlib").sha256(data).hexdigest(), "byteSize": len(data),
                "width": picture.shape[1], "height": picture.shape[0]}
        inputs.append(item)
        images[cid] = decode_input(data, item)
    if document is not None:
        data = sf.jpeg(document, 90)
        cid = str(uuid.uuid4())
        item = {"captureId": cid, "role": "document", "index": None, "step": None, "atMs": None,
                "sha256": __import__("hashlib").sha256(data).hexdigest(), "byteSize": len(data),
                "width": document.shape[1], "height": document.shape[0]}
        inputs.append(item)
        images[cid] = decode_input(data, item)
    claim = {"jobId": str(uuid.uuid4()), "attempt": 1, "kind": kind, "testSession": True, "declaredDocument": "passport",
             "actions": list(actions), "inputs": inputs}
    return claim, images


def timed(name: str, fn):
    cpu, wall = time.process_time(), time.perf_counter()
    out = fn()
    TIMINGS.append((name, time.process_time() - cpu, time.perf_counter() - wall))
    return out


def test_the_models_load_after_their_hashes_are_checked(landmarker):
    assert landmarker is models.landmarker()[0]  # loaded once per process


def test_the_drawn_face_is_found_with_its_mesh_and_blendshapes(landmarker):
    face = main_face(landmarker, sf.render())
    assert face.points.shape == (478, 3)
    assert face.presence > 0.9
    assert set(face.blendshapes) == {"eyeBlinkLeft", "eyeBlinkRight", "mouthSmileLeft", "mouthSmileRight", "jawOpen"}


def test_an_empty_picture_has_no_face(landmarker):
    assert landmarker.faces(np.full((480, 360, 3), 128, np.uint8)) == []


@pytest.mark.parametrize("yaw", [-25, 25])
def test_pose_signs_end_to_end_a_turn_to_the_riders_left_is_positive(landmarker, yaw):
    measured, _, _ = geometry.head_pose(main_face(landmarker, sf.render(yaw=yaw)).points)
    assert np.sign(measured) == np.sign(yaw)
    assert abs(measured - yaw) < 6


def test_pose_signs_end_to_end_looking_up_is_positive(landmarker):
    straight = geometry.head_pose(main_face(landmarker, sf.render()).points)[1]
    up = geometry.head_pose(main_face(landmarker, sf.render(pitch=15)).points)[1]
    assert up - straight > 10


def test_blink_and_smile_move_their_measures(landmarker):
    open_eyes = main_face(landmarker, sf.render())
    closed = main_face(landmarker, sf.render(eyes_closed=True))
    smiling = main_face(landmarker, sf.render(smile=1.0))
    assert geometry.eye_aspect_ratio(closed.points) < 0.6 * geometry.eye_aspect_ratio(open_eyes.points)
    assert geometry.mouth_width(smiling.points) > 1.08 * geometry.mouth_width(open_eyes.points)


def test_flat_plane_a_real_turn_shows_depth_a_tilted_print_does_not(landmarker):
    front = sf.render()
    reference = main_face(landmarker, front)
    turned = main_face(landmarker, sf.render(yaw=22))
    tilted = main_face(landmarker, sf.tilted_print(front, 25))
    assert geometry.planar_residual(reference.points, turned.points) > 0.03
    assert geometry.planar_residual(reference.points, tilted.points) < 0.015
    # The model does not even see a turn in the tilted print: the head-turn action fails on it.
    assert abs(geometry.head_pose(tilted.points)[0]) < 8


def test_a_filmed_screen_shows_moire(landmarker):
    plain = liveness.frame_measure(liveness.Frame(0, 0, sf.render()), landmarker.faces(sf.render()), None)
    filmed_picture = sf.screen(sf.render())
    filmed = liveness.frame_measure(liveness.Frame(0, 0, filmed_picture), landmarker.faces(filmed_picture), None)
    assert filmed["moire"] > 1.0 > plain["moire"]


def test_a_liveness_job_end_to_end(landmarker):
    claim, images = claim_for("liveness", sequence(("turn_left", "blink", "smile")))
    result = timed("liveness job, 13 frames (warm)", lambda: pipeline.analyse(claim, images))
    evidence = result["liveness"]
    assert result["faceMatch"] is None and result["kind"] == "liveness"
    assert evidence["referenceIndex"] == 0
    frames = evidence["frames"]
    assert len(frames) == 13 and all(f["faces"] == 1 for f in frames)
    assert max(f["yaw"] for f in frames[1:5]) > 18  # turned to the rider's left
    assert min(f["eyeOpenness"] for f in frames[5:9]) < 0.6 * frames[0]["eyeOpenness"]
    assert max(f["mouthWidth"] for f in frames[9:13]) > 1.08 * frames[0]["mouthWidth"]
    assert max(f["planarResidual"] for f in frames[1:5]) > 0.03


def test_face_match_same_drawn_person_against_another(landmarker):
    document = sf.document_with_portrait(SPECIMENS / "passport-cmr.jpg", sf.render(sf.ALICE, size=(300, 380), face_width=200), PASSPORT_PORTRAIT_BOX)
    claim, images = claim_for("face_match", sequence(("turn_left", "blink", "smile"), sf.ALICE), document)
    models.reset()  # measure a cold face match: both models load
    same = timed("face_match job, cold (models load)", lambda: pipeline.analyse(claim, images))
    assert same["timing"]["cold"] is True
    same = timed("face_match job, warm", lambda: pipeline.analyse(claim, images))
    other_claim, other_images = claim_for("face_match", sequence(("turn_left", "blink", "smile"), sf.BOB), document)
    other = pipeline.analyse(other_claim, other_images)
    for result in (same, other):
        match = result["faceMatch"]
        assert match["portrait"]["found"] and match["selfie"]["found"]
        assert match["portrait"]["method"] == "mesh"
        # The portrait is found inside the document's portrait box.
        x, y, w, h = match["portrait"]["box"]
        assert 0.05 < x < 0.3 and 0.2 < y < 0.6
        # The best frame looks at the camera: the reference frame or a blink or smile frame.
        assert abs(match["selfie"]["yaw"]) < 10
    assert same["faceMatch"]["similarity"] > other["faceMatch"]["similarity"]
    TIMINGS.append((f"(similarity same {same['faceMatch']['similarity']:.3f}, other {other['faceMatch']['similarity']:.3f})", 0.0, 0.0))


def test_face_match_without_a_portrait(landmarker):
    blank = np.full((900, 1280, 3), 200, np.uint8)
    claim, images = claim_for("face_match", sequence(("turn_left", "blink", "smile")), blank)
    match = pipeline.analyse(claim, images)["faceMatch"]
    assert match["portrait"]["found"] is False and match["similarity"] is None
