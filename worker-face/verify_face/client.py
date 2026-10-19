"""HTTP client for the face Edge Function: POST /claim, /image and /result, each signed.

The AI worker's client (worker/verify_worker/client.py) with the face API's shapes: standard library
only, redirects refused, every response body size-capped, error bodies read only for their error
code, and the claim validated field by field before anything uses it.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

from .contract import (
    DECLARED_DOCUMENTS,
    FACE_JOB_KINDS,
    FACE_LIMITS,
    LIVENESS_ACTIONS,
    MAX_CAPTURE_BYTES,
    MAX_FRAMES,
)
from .imaging import limits
from .signing import Signer

CLAIM_TIMEOUT_S = 15
IMAGE_TIMEOUT_S = 25
RESULT_TIMEOUT_S = 15
MAX_JSON_RESPONSE = 64 * 1024

_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class WorkerApiError(Exception):
    """A request failed. `code` is a short event code (the API's error code when it sent one)."""

    def __init__(self, code: str, status: int | None = None):
        super().__init__(code)
        self.code = code
        self.status = status


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, D401
        return None


def default_opener(proxies: dict[str, str] | None = None) -> urllib.request.OpenerDirector:
    handlers: list[urllib.request.BaseHandler] = [_NoRedirect()]
    if proxies is not None:
        handlers.append(urllib.request.ProxyHandler(proxies))
    return urllib.request.build_opener(*handlers)


@dataclass
class FaceClient:
    """`base_url` is SUPABASE_FACE_URL (https://<ref>.supabase.co/functions/v1/face); `api_key` the
    project's publishable key (it carries no authority)."""

    base_url: str
    api_key: str
    signer: Signer
    opener: urllib.request.OpenerDirector | None = None

    def __post_init__(self) -> None:
        parsed = urllib.parse.urlsplit(self.base_url)
        loopback = parsed.hostname in ("127.0.0.1", "localhost", "::1")
        if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
            raise ValueError("face URL must be https")
        if parsed.query or parsed.fragment:
            raise ValueError("face URL must not have a query")
        self.base_url = self.base_url.rstrip("/")
        if self.opener is None:
            self.opener = default_opener()

    def _post(self, path: str, payload: dict[str, Any], timeout: float, limit: int) -> tuple[int, bytes, str]:
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("ascii")
        headers = {"content-type": "application/json", "apikey": self.api_key, **self.signer.headers(path, body)}
        request = urllib.request.Request(self.base_url + path, data=body, headers=headers, method="POST")
        try:
            with self.opener.open(request, timeout=timeout) as response:  # type: ignore[union-attr]
                data = response.read(limit + 1)
                if len(data) > limit:
                    raise WorkerApiError("response_too_large", response.status)
                return response.status, data, response.headers.get("content-type", "")
        except urllib.error.HTTPError as err:
            raise WorkerApiError(_error_code(err), err.code) from None
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            raise WorkerApiError("network_error") from err

    def claim(self) -> dict[str, Any] | None:
        status, data, _ = self._post("/claim", {}, CLAIM_TIMEOUT_S, MAX_JSON_RESPONSE)
        if status == 204:
            return None
        if status != 200:
            raise WorkerApiError("unexpected_status", status)
        return validate_claim(_json(data))

    def image(self, job_id: str, attempt: int, capture_id: str) -> bytes | None:
        """One input's bytes, or None when there is nothing to do any more (410 gone, 404 lease lost)."""
        try:
            status, data, content_type = self._post(
                "/image", {"jobId": job_id, "attempt": attempt, "captureId": capture_id}, IMAGE_TIMEOUT_S, MAX_CAPTURE_BYTES
            )
        except WorkerApiError as err:
            if err.status in (404, 410):
                return None
            raise
        if status != 200:
            raise WorkerApiError("unexpected_status", status)
        if content_type.split(";")[0].strip().lower() != "image/jpeg":
            raise WorkerApiError("unexpected_content_type", status)
        return data

    def result(self, payload: dict[str, Any]) -> str:
        """"recorded", "already_done", or "gone" (410/404: superseded or lease lost meanwhile)."""
        if len(json.dumps(payload, separators=(",", ":"), ensure_ascii=True)) > FACE_LIMITS["maxBodyBytes"]:
            raise WorkerApiError("result_too_large")
        try:
            status, data, _ = self._post("/result", payload, RESULT_TIMEOUT_S, MAX_JSON_RESPONSE)
        except WorkerApiError as err:
            if err.status in (404, 410):
                return "gone"
            raise
        if status != 200:
            raise WorkerApiError("unexpected_status", status)
        answer = _json(data)
        outcome = answer.get("status") if isinstance(answer, dict) else None
        if outcome not in ("recorded", "already_done"):
            raise WorkerApiError("bad_result_response", status)
        return outcome


def _json(data: bytes) -> Any:
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise WorkerApiError("bad_json") from err


def _error_code(err: urllib.error.HTTPError) -> str:
    try:
        body = json.loads(err.read(MAX_JSON_RESPONSE).decode("utf-8"))
        code = body["error"]["code"]
        if isinstance(code, str) and re.fullmatch(r"[a-z_]{1,40}", code):
            return code
    except Exception:  # noqa: BLE001 - any unreadable error body means the same
        pass
    return f"http_{err.code}"


def _int_in(v: Any, lo: int, hi: int) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def _valid_input(item: Any) -> bool:
    if not isinstance(item, dict) or set(item) != {"captureId", "role", "index", "step", "atMs", "sha256", "byteSize", "width", "height"}:
        return False
    role = item.get("role")
    if role not in ("frame", "document") or not (isinstance(item["captureId"], str) and _UUID.match(item["captureId"])):
        return False
    max_bytes, max_side = limits(role)
    if role == "frame":
        position = _int_in(item["index"], 0, MAX_FRAMES - 1) and _int_in(item["step"], 0, 3) and _int_in(item["atMs"], 0, 60_000)
    else:
        position = item["index"] is None and item["step"] is None and item["atMs"] is None
    return (
        position
        and isinstance(item["sha256"], str) and bool(_SHA256.match(item["sha256"]))
        and _int_in(item["byteSize"], 1, max_bytes)
        and _int_in(item["width"], 1, max_side)
        and _int_in(item["height"], 1, max_side)
    )


def validate_claim(value: Any) -> dict[str, Any]:
    """FaceClaimResponse, checked field by field; anything unexpected is refused."""
    if not isinstance(value, dict):
        raise WorkerApiError("bad_claim")
    inputs = value.get("inputs")
    actions = value.get("actions")
    frames = [i for i in inputs if isinstance(i, dict) and i.get("role") == "frame"] if isinstance(inputs, list) else []
    documents = [i for i in inputs if isinstance(i, dict) and i.get("role") == "document"] if isinstance(inputs, list) else []
    checks = [
        isinstance(value.get("jobId"), str) and bool(_UUID.match(value["jobId"])),
        _int_in(value.get("attempt"), 1, 3),
        value.get("kind") in FACE_JOB_KINDS,
        isinstance(value.get("testSession"), bool),
        value.get("declaredDocument") is None or value.get("declaredDocument") in DECLARED_DOCUMENTS,
        isinstance(actions, list) and 1 <= len(actions) <= 5 and all(a in LIVENESS_ACTIONS for a in actions),
        isinstance(inputs, list) and 1 <= len(inputs) <= FACE_LIMITS["maxInputs"] and all(_valid_input(i) for i in inputs),
        1 <= len(frames) <= MAX_FRAMES and len({f["index"] for f in frames}) == len(frames),
        len(documents) == (1 if value.get("kind") == "face_match" else 0),
    ]
    if not all(checks):
        raise WorkerApiError("bad_claim")
    return value
