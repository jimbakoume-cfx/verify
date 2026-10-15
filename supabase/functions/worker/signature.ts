// Ed25519 signatures of the AI worker's requests (contract.ts, "Worker API"). The worker signs one
// canonical line per request; this file rebuilds it byte for byte as the Python worker does
// (worker/verify_worker/signing.py) and verifies it with WebCrypto, so no dependency is needed.
// signature.vectors.json holds fixed test vectors that both sides check against.
import {
  WORKER_AUDIENCE,
  WORKER_HEADERS,
  WORKER_SIGNATURE_VERSION,
  WORKER_SIGNATURE_WINDOW_S,
} from "../_shared/contract.ts";

/** The signature headers of a request, checked for shape only. */
export interface SignatureHeaders {
  kid: string;
  /** As sent: the canonical line signs the header's text, not a number reformatted from it. */
  timestamp: string;
  nonce: string;
  signature: Uint8Array<ArrayBuffer>;
}

const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;
// Unix seconds, decimal, no sign, no leading zero: one spelling per instant.
const TIMESTAMP_RE = /^[1-9][0-9]{0,11}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;

export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

/** Null when a header is missing or malformed. */
export function readSignatureHeaders(headers: Headers): SignatureHeaders | null {
  const kid = headers.get(WORKER_HEADERS.keyId);
  const timestamp = headers.get(WORKER_HEADERS.timestamp);
  const nonce = headers.get(WORKER_HEADERS.nonce);
  const signatureText = headers.get(WORKER_HEADERS.signature);
  if (kid === null || !KID_RE.test(kid)) return null;
  if (timestamp === null || !TIMESTAMP_RE.test(timestamp)) return null;
  if (nonce === null || !NONCE_RE.test(nonce)) return null;
  const signature = signatureText === null ? null : base64UrlDecode(signatureText, ED25519_SIGNATURE_BYTES);
  if (!signature) return null;
  return { kid, timestamp, nonce, signature };
}

/** The signed line: `v1|confiance-verify/worker|kid|METHOD|path|timestamp|nonce|sha256hex(body)`. */
export function canonicalString(parts: {
  kid: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
}): string {
  return [
    WORKER_SIGNATURE_VERSION,
    WORKER_AUDIENCE,
    parts.kid,
    parts.method,
    parts.path,
    parts.timestamp,
    parts.nonce,
    parts.bodySha256,
  ].join("|");
}

/** True when the timestamp (Unix seconds) is within WORKER_SIGNATURE_WINDOW_S of now, either way. */
export function withinWindow(timestamp: string, nowMs: number): boolean {
  const seconds = Number(timestamp);
  return Number.isSafeInteger(seconds) && Math.abs(nowMs / 1000 - seconds) <= WORKER_SIGNATURE_WINDOW_S;
}

/**
 * Strict base64url without padding, of exactly `byteLength` bytes. Anything else (padding, '+', '/',
 * spaces, unused bits set in the last character) is refused, so each value has a single spelling.
 */
export function base64UrlDecode(value: string, byteLength: number): Uint8Array<ArrayBuffer> | null {
  if (value.length !== Math.ceil((byteLength * 4) / 3) || !/^[A-Za-z0-9_-]*$/.test(value)) return null;
  let binary: string;
  try {
    binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4));
  } catch {
    return null;
  }
  if (binary.length !== byteLength) return null;
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) bytes[i] = binary.charCodeAt(i);
  return base64UrlEncode(bytes) === value ? bytes : null;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Encodings of the points of small order (libsodium's blocklist, checked by curve arithmetic), compared
 * without the sign bit. RFC 8032 does not forbid such a public key, and WebCrypto accepts one: with it,
 * anyone can make a signature that verifies (an all-zero key and an all-zero signature do). Only our
 * own keys go into worker_key, but a placeholder key there must not open the door.
 */
const SMALL_ORDER_POINTS = [
  "0000000000000000000000000000000000000000000000000000000000000000", // order 4
  "0100000000000000000000000000000000000000000000000000000000000000", // order 1 (the identity)
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05", // order 8
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a", // order 8
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // order 2 (p - 1)
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // p, the same point as 0
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // p + 1, the same point as 1
];

export function hasSmallOrder(publicKey: Uint8Array): boolean {
  if (publicKey.byteLength !== ED25519_PUBLIC_KEY_BYTES) return false;
  const masked = Array.from(publicKey, (b, i) => (i === 31 ? b & 0x7f : b).toString(16).padStart(2, "0")).join("");
  return SMALL_ORDER_POINTS.includes(masked);
}

/**
 * Ed25519 (RFC 8032) through WebCrypto. False for a malformed or small-order key and for a malformed
 * signature, never a throw.
 */
export async function verifyEd25519(
  publicKey: Uint8Array<ArrayBuffer>,
  message: Uint8Array<ArrayBuffer>,
  signature: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  if (publicKey.byteLength !== ED25519_PUBLIC_KEY_BYTES || signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    return false;
  }
  if (hasSmallOrder(publicKey)) return false;
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
  } catch {
    return false;
  }
}
