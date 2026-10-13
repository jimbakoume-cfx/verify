import {
  STAFF_PASSWORD_MAX_BYTES,
  STAFF_PASSWORD_MAX_LENGTH,
  STAFF_PASSWORD_MIN_LENGTH,
  passwordByteLength,
} from "@verify/shared";

export interface PasswordRules {
  /** Length within STAFF_PASSWORD_MIN_LENGTH..STAFF_PASSWORD_MAX_LENGTH characters. */
  length: boolean;
  /** At most STAFF_PASSWORD_MAX_BYTES bytes in UTF-8 (the server's bcrypt limit). */
  bytes: boolean;
  /** The server refuses passwords containing the email's local part (the part before "@"). */
  notEmailName: boolean;
  /** Password and confirmation are identical and not empty. */
  matches: boolean;
}

/** Length in characters as the server counts them (code points, so an emoji counts once). */
export function passwordLength(password: string): number {
  return [...password].length;
}

function emailLocalPart(email: string): string {
  const normalised = email.trim().toLowerCase();
  const at = normalised.indexOf("@");
  return at > 0 ? normalised.slice(0, at) : "";
}

export function checkPassword(password: string, confirmation: string, email: string): PasswordRules {
  const length = passwordLength(password);
  const localPart = emailLocalPart(email);
  return {
    length: length >= STAFF_PASSWORD_MIN_LENGTH && length <= STAFF_PASSWORD_MAX_LENGTH,
    bytes: passwordByteLength(password) <= STAFF_PASSWORD_MAX_BYTES,
    // Until the email is typed there is nothing to compare with; the server checks again anyway.
    notEmailName: password.length > 0 && (localPart === "" || !password.toLowerCase().includes(localPart)),
    matches: password.length > 0 && password === confirmation,
  };
}

export function passwordAcceptable(rules: PasswordRules): boolean {
  return rules.length && rules.bytes && rules.notEmailName && rules.matches;
}
