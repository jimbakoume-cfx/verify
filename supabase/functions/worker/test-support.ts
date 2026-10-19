// Helpers for the worker's vitest suites: signing requests the way the Python worker does. Never
// imported by a function entry point, so never deployed.
import { WORKER_HEADERS } from "../_shared/contract.ts";
import { sha256Hex } from "../_shared/crypto.ts";
import { base64UrlEncode, canonicalString } from "./signature.ts";

// DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows (RFC 8410).
const PKCS8_ED25519_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

export interface TestKey {
  kid: string;
  /** base64url of the raw public key, as stored in worker_key. */
  publicKey: string;
  sign(message: string): Promise<string>;
}

/** A key from a 32-byte seed (base64url), as the worker loads WORKER_SIGNING_KEY. */
export async function keyFromSeed(kid: string, seed: Uint8Array): Promise<TestKey> {
  const pkcs8 = Uint8Array.from([...PKCS8_ED25519_PREFIX, ...seed]);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  // The public key is the JWK's x, already base64url without padding.
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  return { kid, publicKey: jwk.x!, sign: (message) => signWith(privateKey, message) };
}

/** A fresh random key. */
export function newKey(kid: string): Promise<TestKey> {
  return keyFromSeed(kid, crypto.getRandomValues(new Uint8Array(32)));
}

async function signWith(privateKey: CryptoKey, message: string): Promise<string> {
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

export interface SignOptions {
  method?: string;
  path: string;
  body: string;
  /** Unix seconds as sent (a string, so tests can send odd spellings). */
  timestamp: string;
  nonce?: string;
  /** Changes what is signed without changing what is sent. */
  tamper?: (canonical: string) => string;
  /** The function's audience (the face worker's since M6/M7); default: the AI worker's. */
  audience?: string;
}

/** The signature headers for a request, as the Python worker builds them. */
export async function signedHeaders(key: TestKey, options: SignOptions): Promise<Record<string, string>> {
  const nonce = options.nonce ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const canonical = canonicalString({
    kid: key.kid,
    method: options.method ?? "POST",
    path: options.path,
    timestamp: options.timestamp,
    nonce,
    bodySha256: await sha256Hex(options.body),
    audience: options.audience,
  });
  return {
    [WORKER_HEADERS.keyId]: key.kid,
    [WORKER_HEADERS.timestamp]: options.timestamp,
    [WORKER_HEADERS.nonce]: nonce,
    [WORKER_HEADERS.signature]: await key.sign(options.tamper ? options.tamper(canonical) : canonical),
  };
}
