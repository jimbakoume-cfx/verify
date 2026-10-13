import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export interface AsyncState<T> {
  /** Last successful result; kept while reloading, cleared when `key` changes. */
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/** Runs `load` when `key` changes and on reload(); results of superseded runs are dropped. */
export function useAsync<T>(load: () => Promise<T>, key: string): AsyncState<T> {
  const [state, setState] = useState<{ key: string; data: T | undefined; error: unknown; loading: boolean }>({
    key,
    data: undefined,
    error: null,
    loading: true,
  });
  const [attempt, setAttempt] = useState(0);
  // The latest closure is used, but only `key` and reload() decide when to run it.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let current = true;
    setState((s) => ({ key, data: s.key === key ? s.data : undefined, error: null, loading: true }));
    loadRef.current().then(
      (data) => current && setState({ key, data, error: null, loading: false }),
      (error: unknown) => current && setState((s) => ({ ...s, error: error ?? new Error("failed"), loading: false })),
    );
    return () => {
      current = false;
    };
  }, [key, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const sameKey = state.key === key;
  return {
    data: sameKey ? state.data : undefined,
    error: sameKey ? state.error : null,
    loading: sameKey ? state.loading : true,
    reload,
  };
}

/** Current time, refreshed every `intervalMs` while `active`. */
export function useNow(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, active]);
  return now;
}

// ---------------------------------------------------------------------------
// Minimal path router: "/" (home) and "/case/<id>". Netlify serves index.html for every path.
// ---------------------------------------------------------------------------
const NAVIGATE_EVENT = "verify:navigate";

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAVIGATE_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAVIGATE_EVENT, onChange);
  };
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function navigate(path: string) {
  if (window.location.pathname === path) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
  window.scrollTo(0, 0);
}
