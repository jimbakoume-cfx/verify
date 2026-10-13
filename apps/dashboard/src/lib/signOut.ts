// Signing out must not depend on the network. supabase-js removes the local session only after its
// POST /logout settles, and that request has no timeout: on a stalled connection the staff pages
// (and any open photo) would stay on screen, and the session would stay in localStorage.

/** How long to wait for the server to end the session before ending it here anyway. */
export const SIGN_OUT_WAIT_MS = 5000;

export interface SignOutDeps {
  signOut(): Promise<unknown>;
  /** Removes the persisted session from this browser. */
  forgetSession(): void;
  /** Starts over from a clean page (the sign-in form). */
  reload(): void;
  waitMs?: number;
}

/**
 * Signs out of this browser. Resolves once the session is gone: by the server's answer, by its
 * failure (supabase-js removes the local session then too), or, if the server does not answer
 * within the wait, by removing the stored session and reloading.
 */
export async function signOutWithin(deps: SignOutDeps): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deps.waitMs ?? SIGN_OUT_WAIT_MS);
  });
  const finished = deps.signOut().then(
    () => "done" as const,
    () => "done" as const,
  );
  const outcome = await Promise.race([finished, timedOut]);
  clearTimeout(timer);
  if (outcome === "timeout") {
    deps.forgetSession();
    deps.reload();
  }
}

/** supabase-js's default storage keys for the auth session: `sb-<project ref>-auth-token...`. */
export function isSupabaseSessionKey(key: string): boolean {
  return /^sb-[a-z0-9-]+-auth-token/.test(key);
}

/** Removes every persisted Supabase Auth session from `storage`. */
export function forgetStoredSessions(storage: Pick<Storage, "length" | "key" | "removeItem">): void {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && isSupabaseSessionKey(key)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}
