// Hashing and random values. Web Crypto only, so the same code runs in Deno and Node.

export async function sha256Hex(input: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

/** 32 random bytes as base64url (43 characters): the rider session token. */
export function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomHex(byteLength = 16): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
