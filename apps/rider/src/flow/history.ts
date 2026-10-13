// The phone's Back button inside the flow. The flow is one page (one history entry), so Back on the
// camera or the review screen would leave the page and lose the photos in memory. While the flow
// handles Back (machine.ts, handlesBack), one extra "guard" entry sits on top of the page's own:
// Back pops the guard, and the flow steps back instead (nav/back), pushing the guard again if the
// new screen still handles Back. A single guard, never one entry per screen: the reducer cannot
// rebuild screens left behind (a discarded photo, a finished upload), so Forward must not lead to
// them. No URL is passed, so the token-free address set by token.ts stays as it is.

const GUARD_KEY = "verifyGuard";

type HistoryWindow = Pick<Window, "history" | "addEventListener" | "removeEventListener">;

function hasGuard(win: HistoryWindow): boolean {
  const state = win.history.state as Record<string, unknown> | null;
  return state !== null && typeof state === "object" && state[GUARD_KEY] === true;
}

/** Puts the guard entry on top unless it is already there (React's StrictMode runs effects twice). */
export function pushBackGuard(win: HistoryWindow = window): void {
  if (hasGuard(win)) return;
  const state = win.history.state as Record<string, unknown> | null;
  win.history.pushState({ ...(state ?? {}), [GUARD_KEY]: true }, "");
}

export interface BackHandler {
  /** Whether the flow handles Back on the screen shown now. */
  handlesBack(): boolean;
  /** Steps the flow back; returns whether the screen it lands on still handles Back. */
  stepBack(): boolean;
}

/**
 * Listens for Back (popstate). On a screen the flow handles, the flow steps back. Otherwise (the
 * guard was still there after the flow moved on, e.g. to the done screen) Back goes on to leave
 * the page, so one press is enough. Returns a function that stops listening.
 */
export function listenForBack(handler: BackHandler, win: HistoryWindow = window): () => void {
  const onPopState = () => {
    if (!handler.handlesBack()) {
      win.history.back();
      return;
    }
    if (handler.stepBack()) pushBackGuard(win);
  };
  win.addEventListener("popstate", onPopState);
  return () => win.removeEventListener("popstate", onPopState);
}
