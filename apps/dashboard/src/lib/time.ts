/** Whole seconds left before `deadlineMs`, rounded up so the display reaches 0:00 exactly at expiry. */
export function secondsLeft(deadlineMs: number, nowMs: number): number {
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

/** "m:ss" under an hour, "h:mm:ss" above. Negative or invalid input shows "0:00". */
export function formatCountdown(totalSeconds: number): string {
  const s = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

/** Milliseconds since the epoch for an ISO timestamp, or NaN when missing or unreadable. */
export function parseTime(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) : Number.NaN;
}
