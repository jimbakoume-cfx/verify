"""Vercel entry point: POST /api/process, the face worker's doorbell (M6/M7).

A standard-library request handler (Vercel's Python runtime looks for a class named `handler`). The
ring's body is ignored and it carries no authority: on every ring the worker claims work from the
Supabase "face" Edge Function with signed requests, processes jobs until there are none left or
about 50 s have passed, then answers {"ok": true}. Nothing else is ever in a response.

Every request is wrapped in a catch-all that logs an event code and the exception's class only
(never a message, a body, or anything measured on a photo). The same code runs on any host that
can serve this handler (see README.md).
"""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

# The function's root (where verify_face/ lives) is on sys.path on Vercel; locally and in tests the
# handler may be loaded from its path instead.
_ROOT = str(Path(__file__).resolve().parent.parent)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from verify_face import log  # noqa: E402
from verify_face.pipeline import analyse  # noqa: E402
from verify_face.runner import ConfigError, client_from_env, run_ring  # noqa: E402

log.configure()

# The ring body is empty; anything bigger is read no further.
MAX_RING_BODY = 1024


def ring() -> tuple[int, dict[str, bool]]:
    """Runs one ring. Returns the status and body to answer with."""
    try:
        client = client_from_env()
    except ConfigError as err:
        log.event(f"ring_failed.{err.code}")
        return 500, {"ok": False}
    summary = run_ring(client, analyse)
    log.event(
        f"ring_done.{summary.stopped}",
        claimed=summary.claimed,
        recorded=summary.recorded,
        already_done=summary.already_done,
        gone=summary.gone,
        rejected=summary.rejected,
    )
    return 200, {"ok": True}


class handler(BaseHTTPRequestHandler):  # noqa: N801 - the name Vercel's runtime looks for
    server_version = "face-worker"
    sys_version = ""

    def do_POST(self) -> None:  # noqa: N802
        try:
            self._drain()
            status, body = ring()
        except Exception as err:  # noqa: BLE001 - the catch-all: log the class only, answer 500
            log.event("ring_failed.unhandled", error=err)
            status, body = 500, {"ok": False}
        self._answer(status, body)

    def _method_not_allowed(self) -> None:
        self._drain()
        self._answer(405, {"ok": False}, allow="POST")

    do_GET = do_HEAD = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _method_not_allowed  # noqa: N815

    def _drain(self) -> None:
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            length = 0
        if length > 0:
            self.rfile.read(min(length, MAX_RING_BODY))

    def _answer(self, status: int, body: dict[str, bool], allow: str | None = None) -> None:
        payload = json.dumps(body, separators=(",", ":")).encode("ascii")
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(payload)))
            if allow:
                self.send_header("allow", allow)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(payload)
        except OSError as err:
            # The caller (the flow function, ~30 s timeout) may have gone: the work is done anyway.
            log.event("answer_failed", error=err)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        # BaseHTTPRequestHandler logs every request line with the client's address: not needed here.
        # (On Vercel the runtime's own handler class comes first and logs the request line from its
        # local proxy, which holds nothing but "POST /api/process" and the status.)
        return
