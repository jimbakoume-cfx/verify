"""The geometry measures on synthetic landmarks (MediaPipe's canonical face, posed and projected): no
model, no face. Includes the numbers the provisional cut-offs of face/decide.ts were set from."""

from __future__ import annotations

import math

import numpy as np
import pytest

from verify_face import geometry as g

RNG = np.random.default_rng(20261019)


def noisy(points: np.ndarray, sigma: float) -> np.ndarray:
    """Landmark noise in the image plane (the mesh model's, about 0.5-1 px on a 100 px face)."""
    out = points.copy()
    out[:, :2] += RNG.normal(0, sigma, (len(points), 2))
    return out


def test_canonical_face_is_the_468_point_model():
    face = g.canonical_face()
    assert face.shape == (468, 3)
    # Symmetric eyes, the nose tip in front.
    assert face[33, 0] == pytest.approx(-face[263, 0])
    assert face[g.NOSE_TIP, 2] > 0.95 * face[:, 2].max()


@pytest.mark.parametrize("yaw", [-30, -15, 0, 15, 30])
@pytest.mark.parametrize("pitch", [-12, 0, 12])
def test_head_pose_recovers_yaw_and_pitch(yaw, pitch):
    est_yaw, est_pitch, est_roll = g.head_pose(g.render_canonical(yaw, pitch))
    assert est_yaw == pytest.approx(yaw, abs=3.0)
    assert est_pitch == pytest.approx(pitch, abs=3.0)
    assert est_roll == pytest.approx(0, abs=2.0)


def test_signs_turning_to_the_riders_left_is_positive_yaw():
    """The frames are the camera's own picture: the rider's left is the image's right. Positive yaw
    moves the nose tip to the image's right (face/decide.ts TURN_LEFT_YAW_SIGN = 1)."""
    straight = g.render_canonical(0, 0)
    turned = g.render_canonical(20, 0)
    assert turned[g.NOSE_TIP, 0] - turned[:, 0].mean() > straight[g.NOSE_TIP, 0] - straight[:, 0].mean()
    assert g.head_pose(turned)[0] > 15


def test_signs_looking_up_is_positive_pitch_and_raises_the_nose():
    up = g.render_canonical(0, 12)
    straight = g.render_canonical(0, 0)
    # y grows downwards in the image.
    assert up[g.NOSE_TIP, 1] - up[:, 1].mean() < straight[g.NOSE_TIP, 1] - straight[:, 1].mean()
    assert g.head_pose(up)[1] > 8


def test_roll():
    assert g.head_pose(g.render_canonical(0, 0, 10))[2] == pytest.approx(10, abs=1.5)


def test_eye_aspect_ratio_and_mouth_width_are_scale_free():
    small = g.render_canonical(0, 0, face_width=90)
    large = g.render_canonical(0, 0, face_width=220)
    assert g.eye_aspect_ratio(small) == pytest.approx(g.eye_aspect_ratio(large), rel=1e-6)
    assert g.mouth_width(small) == pytest.approx(g.mouth_width(large), rel=1e-6)
    assert 0.15 < g.eye_aspect_ratio(large) < 0.45


def test_eye_aspect_ratio_falls_when_the_eyelids_close():
    face = g.render_canonical(0, 0)
    closed = face.copy()
    for eye in (g.EYE_IMAGE_LEFT, g.EYE_IMAGE_RIGHT):
        for top, bottom in zip(eye["top"], eye["bottom"]):
            mid = (closed[top] + closed[bottom]) / 2
            closed[top], closed[bottom] = mid, mid
    assert g.eye_aspect_ratio(closed) < 0.2 * g.eye_aspect_ratio(face)


def test_five_points_are_in_the_template_order():
    pts = g.five_points(g.render_canonical(0, 0))
    left_eye, right_eye, nose, mouth_left, mouth_right = pts
    assert left_eye[0] < nose[0] < right_eye[0]
    assert mouth_left[0] < mouth_right[0]
    assert max(left_eye[1], right_eye[1]) < nose[1] < min(mouth_left[1], mouth_right[1])


def test_umeyama_recovers_a_similarity():
    src = RNG.normal(size=(20, 2))
    angle = 0.4
    r = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
    dst = 2.5 * src @ r.T + [3, -1]
    s, rr, t = g.umeyama(src, dst)
    assert s == pytest.approx(2.5)
    assert np.allclose(rr, r)
    assert np.allclose(t, [3, -1])


@pytest.mark.parametrize("yaw", [12, 20, 30])
def test_flat_plane_a_real_head_turning_shows_parallax(yaw):
    reference = noisy(g.render_canonical(0, 0), 0.5)
    turned = noisy(g.render_canonical(yaw, 0), 0.5)
    assert g.planar_residual(reference, turned) > 0.03  # face/decide.ts FLAT_PLANE_MAX_RESIDUAL is 0.025


@pytest.mark.parametrize("yaw", [12, 20, 30])
def test_flat_plane_a_photo_turned_stays_at_the_noise(yaw):
    """A print or a screen moved in front of the camera: every point moves by one homography."""
    reference = noisy(g.render_canonical(0, 0, flat=True), 1.0)
    turned = noisy(g.render_canonical(yaw, 0, flat=True), 1.0)
    assert g.planar_residual(reference, turned) < 0.025


def test_flat_plane_looking_up_also_shows_parallax():
    assert g.planar_residual(g.render_canonical(0, 0), g.render_canonical(0, 12)) > 0.03


def test_shape_distance_same_face_versus_another():
    reference = noisy(g.render_canonical(0, 0), 0.5)
    same = noisy(g.render_canonical(8, 4), 0.5)
    other_shape = g.canonical_face() * [1.15, 0.9, 1.2]
    other = noisy(g.render_canonical(8, 4, shape=other_shape), 0.5)
    assert g.shape_distance(reference, same) < 0.04
    assert g.shape_distance(reference, other) > g.shape_distance(reference, same)


def test_render_canonical_flat_has_no_depth():
    assert np.ptp(g.render_canonical(0, 0, flat=True)[:, 2]) == pytest.approx(0, abs=1e-9)
