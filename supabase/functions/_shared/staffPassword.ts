// Staff password limits that contract.ts does not state, shared by the admin function and the
// dashboard (through @verify/shared) so both refuse exactly the same passwords. Dependency-free.

/**
 * Supabase Auth hashes passwords with bcrypt, which only takes 72 bytes and refuses longer
 * passwords. UTF-8: an accented letter is 2 bytes, many symbols and emoji 3 or 4, so a password of
 * fewer than STAFF_PASSWORD_MAX_LENGTH characters can still be too long.
 */
export const STAFF_PASSWORD_MAX_BYTES = 72;

/** Size of `password` in UTF-8 bytes, as bcrypt counts it. */
export function passwordByteLength(password: string): number {
  return new TextEncoder().encode(password).byteLength;
}
