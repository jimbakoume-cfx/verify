"""Log hygiene (as the AI worker's, worker/verify_worker/log.py): the face worker logs short event codes and exception class names, nothing else.

Never pass a measure, an image, a request or response body, or an exception message here:
exception messages can quote data (a parser error showing the text it choked on). Third-party
loggers are turned down to ERROR so that libraries cannot log what they processed either.
"""

from __future__ import annotations

import logging
import re

_LOGGER = logging.getLogger("verify_face")
_CODE = re.compile(r"^[a-z][a-z0-9_.]{0,63}$")
# Libraries in the processing path.
_QUIET = ("onnxruntime", "PIL", "urllib3", "ai_edge_litert", "tflite_runtime", "absl")

_configured = False


def configure() -> None:
    """Idempotent: one plain handler on our logger, everything else at ERROR."""
    global _configured
    if _configured:
        return
    for name in _QUIET:
        logging.getLogger(name).setLevel(logging.ERROR)
    if not _LOGGER.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
        _LOGGER.addHandler(handler)
    _LOGGER.setLevel(logging.INFO)
    _LOGGER.propagate = False
    _configured = True


def event(code: str, *, error: BaseException | None = None, level: int = logging.INFO, **counts: int | float) -> None:
    """Logs `code`, the class of `error` (never its message) and a few numbers (counts, timings)."""
    if not _CODE.match(code):
        code = "invalid_log_code"
    parts = [code]
    if error is not None:
        parts.append(f"error={type(error).__name__}")
        if level < logging.WARNING:
            level = logging.WARNING
    for key, value in counts.items():
        # Numbers only: a string here could carry data.
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        parts.append(f"{key}={round(value, 3) if isinstance(value, float) else value}")
    _LOGGER.log(level, " ".join(parts))
