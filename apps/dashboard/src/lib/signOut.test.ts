import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetStoredSessions, isSupabaseSessionKey, signOutWithin } from "./signOut";

describe("signOutWithin", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is done when the server answers, without reloading", async () => {
    const deps = { signOut: vi.fn(async () => ({ error: null })), forgetSession: vi.fn(), reload: vi.fn() };
    await signOutWithin(deps);
    expect(deps.signOut).toHaveBeenCalledOnce();
    expect(deps.forgetSession).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it("is done when the request fails (supabase-js clears the session itself)", async () => {
    const deps = { signOut: vi.fn(async () => Promise.reject(new Error("offline"))), forgetSession: vi.fn(), reload: vi.fn() };
    await signOutWithin(deps);
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it("ends the session here when the server does not answer in time", async () => {
    vi.useFakeTimers();
    const deps = { signOut: () => new Promise<never>(() => {}), forgetSession: vi.fn(), reload: vi.fn(), waitMs: 5000 };
    const done = signOutWithin(deps);
    await vi.advanceTimersByTimeAsync(4999);
    expect(deps.forgetSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(deps.forgetSession).toHaveBeenCalledOnce();
    expect(deps.reload).toHaveBeenCalledOnce();
  });
});

describe("forgetStoredSessions", () => {
  it("removes Supabase Auth sessions and nothing else", () => {
    const store = new Map([
      ["sb-abcdefghijklmnop-auth-token", "{}"],
      ["sb-abcdefghijklmnop-auth-token-code-verifier", "x"],
      ["verify.lang", "fr"],
    ]);
    const storage = {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      removeItem: (k: string) => void store.delete(k),
    };
    forgetStoredSessions(storage);
    expect([...store.keys()]).toEqual(["verify.lang"]);
    expect(isSupabaseSessionKey("verify.lang")).toBe(false);
  });
});
