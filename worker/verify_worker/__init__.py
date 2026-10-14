"""Confiance Verify AI worker (M3).

Claims jobs from the Supabase "worker" Edge Function, re-checks each photo (quality, code lines,
document type, a few printed fields) and sends back evidence only: the Edge Function makes every
decision. Images stay in memory; raw OCR text never leaves this process. See README.md.
"""

# Worker build, sent with every result (WorkerResultRequest.engine, at most 60 characters).
WORKER_VERSION = "worker-1"
OCR_LABEL = "rapidocr-3.9.2/ppocrv6-small"
ENGINE = f"{WORKER_VERSION}/{OCR_LABEL}"
