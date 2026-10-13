import { describe, expect, it } from "vitest";
import {
  SESSION_STORAGE_KEY,
  forgetSessionToken,
  isSessionToken,
  parseFragmentToken,
  reloadOnNewLink,
  resolveSessionToken,
  stripTokenFromHash,
  takeSessionToken,
} from "./token";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde"; // 43 base64url characters
const OTHER = "Zz9_-Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0PpOoNnMmLlK";

describe("isSessionToken", () => {
  it("accepts 43 base64url characters only", () => {
    expect(TOKEN).toHaveLength(43);
    expect(isSessionToken(TOKEN)).toBe(true);
    expect(isSessionToken(TOKEN.slice(1))).toBe(false);
    expect(isSessionToken(`${TOKEN}=`)).toBe(false);
    expect(isSessionToken(TOKEN.replace("A", "+"))).toBe(false);
    expect(isSessionToken(TOKEN.replace("A", "/"))).toBe(false);
    expect(isSessionToken(null)).toBe(false);
  });
});

describe("parseFragmentToken", () => {
  it("reads #s=<token>", () => {
    expect(parseFragmentToken(`#s=${TOKEN}`)).toEqual({ kind: "token", token: TOKEN });
    expect(parseFragmentToken(`s=${TOKEN}`)).toEqual({ kind: "token", token: TOKEN });
  });

  it("ignores other fragment parameters", () => {
    expect(parseFragmentToken(`#lang=en&s=${TOKEN}`)).toEqual({ kind: "token", token: TOKEN });
  });

  it("reports no token when the fragment has none", () => {
    expect(parseFragmentToken("")).toEqual({ kind: "none" });
    expect(parseFragmentToken("#")).toEqual({ kind: "none" });
    expect(parseFragmentToken("#section-2")).toEqual({ kind: "none" });
  });

  it("flags a malformed token instead of ignoring it", () => {
    expect(parseFragmentToken("#s=")).toEqual({ kind: "invalid" });
    expect(parseFragmentToken(`#s=${TOKEN.slice(0, 30)}`)).toEqual({ kind: "invalid" });
    expect(parseFragmentToken(`#s=${TOKEN}%20`)).toEqual({ kind: "invalid" });
  });
});

describe("stripTokenFromHash", () => {
  it("removes s and keeps the rest", () => {
    expect(stripTokenFromHash(`#s=${TOKEN}`)).toBe("");
    expect(stripTokenFromHash(`#s=${TOKEN}&lang=en`)).toBe("lang=en");
  });
});

describe("resolveSessionToken", () => {
  it("prefers the link over the remembered token", () => {
    expect(resolveSessionToken(`#s=${TOKEN}`, OTHER)).toEqual({ token: TOKEN, invalidLink: false });
  });

  it("falls back to the remembered token (reload)", () => {
    expect(resolveSessionToken("", OTHER)).toEqual({ token: OTHER, invalidLink: false });
  });

  it("ignores a corrupted remembered token", () => {
    expect(resolveSessionToken("", "garbage")).toEqual({ token: null, invalidLink: false });
  });

  it("does not fall back when the link itself is broken", () => {
    expect(resolveSessionToken("#s=abc", OTHER)).toEqual({ token: null, invalidLink: true });
  });

  it("has no token without a link or a remembered one", () => {
    expect(resolveSessionToken("", null)).toEqual({ token: null, invalidLink: false });
  });
});

function fakeWindow(url: string, stored: Record<string, string> = {}) {
  const u = new URL(url);
  const store = new Map(Object.entries(stored));
  const replaced: string[] = [];
  const win = {
    location: { hash: u.hash, pathname: u.pathname, search: u.search },
    history: {
      state: null,
      replaceState: (_s: unknown, _t: string, next: string) => replaced.push(next),
    },
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
  return { win: win as unknown as Window, store, replaced };
}

describe("takeSessionToken", () => {
  it("stores the token and removes it from the address bar, keeping the query", () => {
    const { win, store, replaced } = fakeWindow(`https://rider.example/?debug=1#s=${TOKEN}`);
    expect(takeSessionToken(win)).toEqual({ token: TOKEN, invalidLink: false });
    expect(store.get(SESSION_STORAGE_KEY)).toBe(TOKEN);
    expect(replaced).toEqual(["/?debug=1"]);
  });

  it("reuses the remembered token without touching the URL", () => {
    const { win, replaced } = fakeWindow("https://rider.example/", { [SESSION_STORAGE_KEY]: TOKEN });
    expect(takeSessionToken(win).token).toBe(TOKEN);
    expect(replaced).toEqual([]);
  });

  it("removes a malformed token from the address bar too", () => {
    const { win, store, replaced } = fakeWindow("https://rider.example/#s=abc&x=1");
    expect(takeSessionToken(win)).toEqual({ token: null, invalidLink: true });
    expect(store.size).toBe(0);
    expect(replaced).toEqual(["/#x=1"]);
  });

  it("works when sessionStorage is unavailable", () => {
    const { win } = fakeWindow(`https://rider.example/#s=${TOKEN}`);
    Object.defineProperty(win, "sessionStorage", {
      get() {
        throw new Error("SecurityError");
      },
    });
    expect(takeSessionToken(win).token).toBe(TOKEN);
    expect(() => forgetSessionToken(win)).not.toThrow();
  });

  it("forgets the token", () => {
    const { win, store } = fakeWindow("https://rider.example/", { [SESSION_STORAGE_KEY]: TOKEN });
    forgetSessionToken(win);
    expect(store.has(SESSION_STORAGE_KEY)).toBe(false);
  });
});

describe("reloadOnNewLink", () => {
  function hashWindow() {
    const listeners = new Set<() => void>();
    let reloads = 0;
    const win = {
      location: { hash: "", reload: () => void reloads++ },
      addEventListener: (type: string, l: () => void) => type === "hashchange" && listeners.add(l),
      removeEventListener: (type: string, l: () => void) => type === "hashchange" && listeners.delete(l),
    };
    return {
      win: win as unknown as Window,
      open(hash: string) {
        win.location.hash = hash;
        listeners.forEach((l) => l());
      },
      get reloads() {
        return reloads;
      },
      get listeners() {
        return listeners.size;
      },
    };
  }

  it("reloads when a new link (or a broken one) is opened in the same tab", () => {
    const h = hashWindow();
    reloadOnNewLink(h.win);
    h.open(`#s=${TOKEN}`);
    expect(h.reloads).toBe(1);
    h.open("#s=abc");
    expect(h.reloads).toBe(2);
  });

  it("ignores fragments without a token", () => {
    const h = hashWindow();
    const stop = reloadOnNewLink(h.win);
    h.open("");
    h.open("#x=1");
    expect(h.reloads).toBe(0);
    stop();
    expect(h.listeners).toBe(0);
  });
});
