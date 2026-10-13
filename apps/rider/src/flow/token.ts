// The rider's session token arrives in the URL fragment (#s=<token>), which browsers never send to
// a server or put in a Referer. It is kept for this tab only (sessionStorage) and removed from the
// address bar straight away, so it does not linger in history, screenshots or shared links.

/** sessionStorage key holding the token for this tab. */
export const SESSION_STORAGE_KEY = "verify.session";

/** 32 random bytes in base64url without padding, as issued by the server. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function isSessionToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

export type FragmentToken =
  | { kind: "none" }
  | { kind: "token"; token: string }
  /** The link carries `s=` but not a well-formed token (e.g. cut off when copied). */
  | { kind: "invalid" };

function fragmentParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.replace(/^#/, ""));
}

/** Reads the `s` parameter of a URL fragment such as `#s=<token>`; other parameters are ignored. */
export function parseFragmentToken(hash: string): FragmentToken {
  const params = fragmentParams(hash);
  if (!params.has("s")) return { kind: "none" };
  const token = params.get("s") ?? "";
  return isSessionToken(token) ? { kind: "token", token } : { kind: "invalid" };
}

/** The fragment without `s` (and without "#"), or "" when nothing else is left. */
export function stripTokenFromHash(hash: string): string {
  const params = fragmentParams(hash);
  params.delete("s");
  return params.toString();
}

export interface ResolvedToken {
  token: string | null;
  /** The link held a malformed token: show "link not valid" rather than falling back. */
  invalidLink: boolean;
}

/**
 * Decides which token this tab uses. A token in the link wins over the remembered one (the rider
 * opened a newer link); without one in the link, the remembered token keeps a reload working.
 */
export function resolveSessionToken(hash: string, stored: string | null): ResolvedToken {
  const fromLink = parseFragmentToken(hash);
  if (fromLink.kind === "token") return { token: fromLink.token, invalidLink: false };
  if (fromLink.kind === "invalid") return { token: null, invalidLink: true };
  return { token: isSessionToken(stored) ? stored : null, invalidLink: false };
}

function readStored(storage: Storage | null): string | null {
  try {
    return storage?.getItem(SESSION_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function sessionStore(win: Window): Storage | null {
  try {
    return win.sessionStorage;
  } catch {
    // Storage disabled (some WebViews): the token then lives in memory only, until a reload.
    return null;
  }
}

/**
 * Start-up step: picks the token, remembers it for this tab and removes it from the address bar.
 * Call it before rendering anything.
 */
export function takeSessionToken(win: Window = window): ResolvedToken {
  const storage = sessionStore(win);
  const { hash, pathname, search } = win.location;
  const resolved = resolveSessionToken(hash, readStored(storage));
  if (resolved.token) {
    try {
      storage?.setItem(SESSION_STORAGE_KEY, resolved.token);
    } catch {
      // Quota or privacy mode: keep going with the in-memory token.
    }
  }
  if (parseFragmentToken(hash).kind !== "none") {
    const rest = stripTokenFromHash(hash);
    win.history.replaceState(win.history.state, "", `${pathname}${search}${rest ? `#${rest}` : ""}`);
  }
  return resolved;
}

/** Forgets the token of this tab (expired, invalid or already used). */
export function forgetSessionToken(win: Window = window): void {
  try {
    sessionStore(win)?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Nothing to forget.
  }
}

/**
 * A new `#s=` link opened in this tab (a fresh test link pasted in the address bar, or the app's
 * WebView loading another link) only changes the fragment, so the page does not reload by itself:
 * the old session would stay on screen and the new token in the address bar. Reloading lets
 * takeSessionToken pick the new token and remove it from the URL. replaceState never fires
 * hashchange, so this cannot loop. Returns a function that stops listening.
 */
export function reloadOnNewLink(win: Window = window): () => void {
  const onHashChange = () => {
    if (parseFragmentToken(win.location.hash).kind !== "none") win.location.reload();
  };
  win.addEventListener("hashchange", onHashChange);
  return () => win.removeEventListener("hashchange", onHashChange);
}
