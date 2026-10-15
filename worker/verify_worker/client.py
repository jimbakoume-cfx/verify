"""HTTP client for the worker Edge Function: POST /claim, /image and /result, each signed.

Standard library only (urllib). Redirects are refused (a signed request is only ever sent to the
configured function), every response body is size-capped, and error bodies are read only for
their error code. Nothing here logs: the runner logs event codes.
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
    CAPTURE_SIDES,
    DECLARED_DOCUMENTS,
    MAX_CAPTURE_BYTES,
    MAX_LONG_SIDE,
    MRZ_FORMATS,
    WORKER_LIMITS,
)
from .signing import Signer

CLAIM_TIMEOUT_S = 15
IMAGE_TIMEOUT_S = 25
RESULT_TIMEOUT_S = 15
# JSON answers are small; anything larger is not from our function.
MAX_JSON_RESPONSE = 64 * 1024

_UUIDISH = re.compile(r"^[A-Za-z0-9-]{1,64}$")
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
    """No redirects; proxies from the environment unless given (tests pass {} for none)."""
    handlers: list[urllib.request.BaseHandler] = [_NoRedirect()]
    if proxies is not None:
        handlers.append(urllib.request.ProxyHandler(proxies))
    return urllib.request.build_opener(*handlers)


@dataclass
class WorkerClient:
    """`base_url` is SUPABASE_WORKER_URL (https://<ref>.supabase.co/functions/v1/worker); `api_key` is
    the project's publishable key, sent as `apikey` like the web apps do (it carries no authority)."""

    base_url: str
    api_key: str
    signer: Signer
    opener: urllib.request.OpenerDirector | None = None

    def __post_init__(self) -> None:
        parsed = urllib.parse.urlsplit(self.base_url)
        loopback = parsed.hostname in ("127.0.0.1", "localhost", "::1")
        if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
            raise ValueError("worker URL must be https")
        if parsed.query or parsed.fragment:
            raise ValueError("worker URL must not have a query")
        self.base_url = self.base_url.rstrip("/")
        if self.opener is None:
            self.opener = default_opener()

    # -- transport ---------------------------------------------------------------------------------
    def _post(self, path: str, payload: dict[str, Any], timeout: float, limit: int) -> tuple[int, bytes, str]:
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("ascii")
        headers = {
            "content-type": "application/json",
            "apikey": self.api_key,
            **self.signer.headers(path, body),
        }
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

    # -- API ---------------------------------------------------------------------------------------
    def claim(self) -> dict[str, Any] | None:
        """The next job, or None when there is none (204)."""
        status, data, _ = self._post("/claim", {}, CLAIM_TIMEOUT_S, MAX_JSON_RESPONSE)
        if status == 204:
            return None
        if status != 200:
            raise WorkerApiError("unexpected_status", status)
        return validate_claim(_json(data))

    def image(self, job_id: str, attempt: int) -> bytes | None:
        """The photo's bytes, or None when there is nothing to do any more: 410 (the photo was
        erased, retaken or superseded) or 404 (this attempt's lease is gone)."""
        try:
            status, data, content_type = self._post(
                "/image", {"jobId": job_id, "attempt": attempt}, IMAGE_TIMEOUT_S, MAX_CAPTURE_BYTES
            )
        except WorkerApiError as err:
            if err.status in (404, 410):
                return None
            raise
        if status != 200:
            raise WorkerApiError("unexpected_status", status)
        if not content_type.split(";")[0].strip().lower() == "image/jpeg":
            raise WorkerApiError("unexpected_content_type", status)
        return data

    def result(self, payload: dict[str, Any]) -> str:
        """Sends the evidence; returns "recorded", "already_done" (an earlier attempt's result won), or
        "gone" (410: the photo was superseded or erased meanwhile; 404: this attempt is no longer
        the job's)."""
        body_size = len(json.dumps(payload, separators=(",", ":"), ensure_ascii=True))
        if body_size > WORKER_LIMITS["maxBodyBytes"]:
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
    """The API's error code from an error body ({ error: { code } }), else a generic one."""
    try:
        body = json.loads(err.read(MAX_JSON_RESPONSE).decode("utf-8"))
        code = body["error"]["code"]
        if isinstance(code, str) and re.fullmatch(r"[a-z_]{1,40}", code):
            return code
    except Exception:  # noqa: BLE001 - any unreadable error body means the same
        pass
    return f"http_{err.code}"


def validate_claim(value: Any) -> dict[str, Any]:
    """The claim, checked field by field (WorkerClaimResponse); anything unexpected is refused."""
    if not isinstance(value, dict):
        raise WorkerApiError("bad_claim")

    def ok_int(v: Any, lo: int, hi: int) -> bool:
        return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi

    image = value.get("image")
    expectation = value.get("mrzExpectation")
    checks = [
        isinstance(value.get("jobId"), str) and bool(_UUIDISH.match(value["jobId"])),
        ok_int(value.get("attempt"), 1, 1000),
        isinstance(value.get("captureId"), str) and bool(_UUIDISH.match(value["captureId"])),
        value.get("side") in CAPTURE_SIDES,
        value.get("declaredDocument") in DECLARED_DOCUMENTS,
        expectation is None
        or (
            isinstance(expectation, dict)
            and expectation.get("side") in CAPTURE_SIDES
            and expectation.get("format") in MRZ_FORMATS
            and isinstance(expectation.get("required"), bool)
        ),
        isinstance(image, dict)
        and isinstance(image.get("sha256"), str)
        and bool(_SHA256.match(image["sha256"]))
        and ok_int(image.get("byteSize"), 1, MAX_CAPTURE_BYTES)
        and ok_int(image.get("width"), 1, MAX_LONG_SIDE)
        and ok_int(image.get("height"), 1, MAX_LONG_SIDE),
    ]
    if not all(checks):
        raise WorkerApiError("bad_claim")
    return value
