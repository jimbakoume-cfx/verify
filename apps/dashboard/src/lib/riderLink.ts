// The test-session panel's second QR code: the same rider link with ?debug=1, which makes the rider
// app show its measurements and what it read from the code lines (✅/❌ per check digit).
// The link carries the session token in its fragment (#s=...): it is only ever shown, never logged.

/**
 * The rider link with debug=1 added to its query string, before the fragment:
 * https://host/#s=TOKEN becomes https://host/?debug=1#s=TOKEN. Null when the link is not an
 * http(s) URL, so no debug QR code is offered rather than a broken one.
 */
export function debugRiderUrl(riderUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(riderUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.searchParams.set("debug", "1");
  return url.toString();
}
