import { describe, expect, it } from "vitest";
import { WORKER_HEADERS, WORKER_SIGNATURE_WINDOW_S } from "../_shared/contract.ts";
import { sha256Hex } from "../_shared/crypto.ts";
import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalString,
  hasSmallOrder,
  readSignatureHeaders,
  verifyEd25519,
  withinWindow,
} from "./signature.ts";
import vectors from "./signature.vectors.json" with { type: "json" };
import { keyFromSeed } from "./test-support.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const hex = (text: string) => Uint8Array.from(text.match(/../g)!, (byte) => parseInt(byte, 16));

describe("fixed test vectors (shared with the Python worker)", () => {
  const publicKey = base64UrlDecode(vectors.public, 32)!;

  it("use the RFC 8032 TEST 1 key, which WebCrypto verifies as published", async () => {
    expect(publicKey).not.toBeNull();
    expect(base64UrlEncode(hex(vectors.rfc8032.publicHex))).toBe(vectors.public);
    expect(base64UrlEncode(hex(vectors.rfc8032.seedHex))).toBe(vectors.seed);
    expect(await verifyEd25519(publicKey, encode(vectors.rfc8032.message), hex(vectors.rfc8032.signatureHex))).toBe(true);
  });

  it("derive the public key from the seed", async () => {
    const key = await keyFromSeed(vectors.kid, base64UrlDecode(vectors.seed, 32)!);
    expect(key.publicKey).toBe(vectors.public);
  });

  it.each(vectors.cases)("$name: canonical string, body hash and signature", async (c) => {
    expect(await sha256Hex(c.body)).toBe(c.bodySha256);
    expect(canonicalString({ kid: vectors.kid, method: c.method, path: c.path, timestamp: c.timestamp, nonce: c.nonce, bodySha256: c.bodySha256 }))
      .toBe(c.canonical);
    const signature = base64UrlDecode(c.signature, 64)!;
    expect(await verifyEd25519(publicKey, encode(c.canonical), signature)).toBe(true);
    // Ed25519 is deterministic: signing again gives the same bytes.
    const key = await keyFromSeed(vectors.kid, base64UrlDecode(vectors.seed, 32)!);
    expect(await key.sign(c.canonical)).toBe(c.signature);
  });

  it.each(vectors.cases)("$name: any change to the signed line fails", async (c) => {
    const signature = base64UrlDecode(c.signature, 64)!;
    const variants = [
      c.canonical.replace("confiance-verify/worker", "confiance-verify/other"),
      c.canonical.replace(`|${c.path}|`, c.path === "/claim" ? "|/result|" : "|/claim|"),
      c.canonical.replace("|POST|", "|GET|"),
      c.canonical.replace(`|${c.timestamp}|`, `|${Number(c.timestamp) + 1}|`),
      c.canonical.replace(`|${c.nonce}|`, `|${"0".repeat(32)}|`),
      c.canonical.replace(c.bodySha256, "f".repeat(64)),
      c.canonical.replace(`|${vectors.kid}|`, "|other-key|"),
      c.canonical.replace("v1|", "v2|"),
    ];
    for (const variant of variants) {
      expect(variant).not.toBe(c.canonical);
      expect(await verifyEd25519(publicKey, encode(variant), signature)).toBe(false);
    }
  });
});

describe("verifyEd25519", () => {
  it("is false, never a throw, for malformed keys and signatures", async () => {
    const message = encode("x");
    expect(await verifyEd25519(new Uint8Array(31), message, new Uint8Array(64))).toBe(false);
    expect(await verifyEd25519(new Uint8Array(32), message, new Uint8Array(63))).toBe(false);
    expect(await verifyEd25519(Uint8Array.from({ length: 32 }, (_, i) => i + 1), message, new Uint8Array(64))).toBe(false);
  });

  it("refuses small-order public keys, which WebCrypto would accept with a forged signature", async () => {
    const zero = new Uint8Array(32);
    expect(hasSmallOrder(zero)).toBe(true);
    // The forgery: an all-zero key "verifies" an all-zero signature on any message.
    expect(await verifyEd25519(zero, encode("anything"), new Uint8Array(64))).toBe(false);
    const identity = new Uint8Array(32);
    identity[0] = 1;
    expect(await verifyEd25519(identity, encode("anything"), Uint8Array.from([1, ...new Array(63).fill(0)]))).toBe(false);
    // The sign bit does not matter.
    const signed = new Uint8Array(32);
    signed[31] = 0x80;
    expect(hasSmallOrder(signed)).toBe(true);
    const order8 = hex("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a");
    expect(hasSmallOrder(order8)).toBe(true);
    order8[31] |= 0x80;
    expect(hasSmallOrder(order8)).toBe(true);
    expect(hasSmallOrder(base64UrlDecode(vectors.public, 32)!)).toBe(false);
  });

  it("refuses another key's signature", async () => {
    const key = await keyFromSeed("a", new Uint8Array(32).fill(1));
    const other = await keyFromSeed("b", new Uint8Array(32).fill(2));
    const signature = base64UrlDecode(await key.sign("hello"), 64)!;
    expect(await verifyEd25519(base64UrlDecode(key.publicKey, 32)!, encode("hello"), signature)).toBe(true);
    expect(await verifyEd25519(base64UrlDecode(other.publicKey, 32)!, encode("hello"), signature)).toBe(false);
  });
});

describe("base64UrlDecode", () => {
  it("round-trips exact lengths", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    expect(base64UrlDecode(base64UrlEncode(bytes), 32)).toEqual(bytes);
  });

  it("refuses padding, standard base64, spaces, wrong lengths and unused bits", () => {
    const valid = vectors.public;
    expect(base64UrlDecode(`${valid}=`, 32)).toBeNull();
    expect(base64UrlDecode(valid.replace(/_/g, "/"), 32)).toBeNull();
    expect(base64UrlDecode(` ${valid.slice(1)}`, 32)).toBeNull();
    expect(base64UrlDecode(valid.slice(1), 32)).toBeNull();
    expect(base64UrlDecode(valid, 31)).toBeNull();
    // The last character of 32 bytes carries 4 unused bits: only one spelling is accepted.
    const last = valid[valid.length - 1];
    const alias = "AEIMQUYcgkosw048".includes(last) ? String.fromCharCode(last.charCodeAt(0) + 1) : last;
    expect(base64UrlDecode(valid.slice(0, -1) + alias, 32)).toBeNull();
  });
});

describe("readSignatureHeaders", () => {
  const good = {
    [WORKER_HEADERS.keyId]: vectors.kid,
    [WORKER_HEADERS.timestamp]: vectors.cases[0].timestamp,
    [WORKER_HEADERS.nonce]: vectors.cases[0].nonce,
    [WORKER_HEADERS.signature]: vectors.cases[0].signature,
  };

  it("reads well-formed headers", () => {
    const parsed = readSignatureHeaders(new Headers(good));
    expect(parsed).toMatchObject({ kid: vectors.kid, timestamp: vectors.cases[0].timestamp, nonce: vectors.cases[0].nonce });
    expect(parsed?.signature).toHaveLength(64);
  });

  it.each([
    ["no key id", WORKER_HEADERS.keyId, null],
    ["a key id with a space", WORKER_HEADERS.keyId, "my key"],
    ["a key id of 65 characters", WORKER_HEADERS.keyId, "k".repeat(65)],
    ["no timestamp", WORKER_HEADERS.timestamp, null],
    ["a timestamp in milliseconds with a decimal point", WORKER_HEADERS.timestamp, "1791968400.5"],
    ["a negative timestamp", WORKER_HEADERS.timestamp, "-1"],
    ["a timestamp with a leading zero", WORKER_HEADERS.timestamp, "01791968400"],
    ["an ISO timestamp", WORKER_HEADERS.timestamp, "2026-10-14T09:00:00Z"],
    ["no nonce", WORKER_HEADERS.nonce, null],
    ["an upper-case nonce", WORKER_HEADERS.nonce, "00112233445566778899AABBCCDDEEFF"],
    ["a short nonce", WORKER_HEADERS.nonce, "0011"],
    ["no signature", WORKER_HEADERS.signature, null],
    ["a padded signature", WORKER_HEADERS.signature, `${vectors.cases[0].signature}==`],
    ["a short signature", WORKER_HEADERS.signature, vectors.cases[0].signature.slice(2)],
  ])("refuses %s", (_label, name, value) => {
    const headers = new Headers(good);
    if (value === null) headers.delete(name);
    else headers.set(name, value);
    expect(readSignatureHeaders(headers)).toBeNull();
  });
});

describe("withinWindow", () => {
  const now = 1_791_968_400_000;
  it.each([
    [0, true],
    [WORKER_SIGNATURE_WINDOW_S, true],
    [-WORKER_SIGNATURE_WINDOW_S, true],
    [WORKER_SIGNATURE_WINDOW_S + 1, false],
    [-(WORKER_SIGNATURE_WINDOW_S + 1), false],
    [3600, false],
  ])("a timestamp %i s from now -> %s", (offset, expected) => {
    expect(withinWindow(String(now / 1000 + offset), now)).toBe(expected);
  });
});
