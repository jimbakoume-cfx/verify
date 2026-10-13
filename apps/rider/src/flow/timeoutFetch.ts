// supabase-js has no timeout of its own, and storage-js calls fetch without a signal: a mobile
// connection that stalls (weak signal, a tunnel, a dead TCP connection) would leave the photo
// upload pending for ever, with no automatic retry and no "Try again" button. The rider's Supabase
// client is given this fetch instead (main.tsx); the abort then surfaces as a storage error with
// no status, which storage.ts classifies as a transient timeout, so the usual retries take over.

/**
 * Total time allowed for one storage request. A whole budget, not an idle limit (fetch cannot
 * report upload progress): a 300 KB photo takes about a minute at 40 kbit/s (EDGE, weak 3G), so a
 * slow upload that is still moving is not cut short.
 */
export const STORAGE_UPLOAD_TIMEOUT_MS = 120_000;

/**
 * A fetch that aborts after `ms`, and still honours the caller's own signal. Avoids
 * AbortSignal.any / AbortSignal.timeout, which older Android WebViews and Safari before 17.4 lack.
 */
export function timeoutFetch(ms: number, base: typeof fetch = (...args) => globalThis.fetch(...args)): typeof fetch {
  return (input, init) => {
    const controller = new AbortController();
    const outer = init?.signal;
    if (outer?.aborted) controller.abort(outer.reason);
    else outer?.addEventListener("abort", () => controller.abort(outer.reason), { once: true });
    const timer = setTimeout(() => controller.abort(), ms);
    return base(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  };
}
