// Which language the rider sees: their own choice (?lang= in the link, or the toggle) wins; else
// the session's language, set by whoever created the session (the Confiance app, or staff for a
// test session); else the phone's settings (initI18n).
import { type Language, isSupportedLanguage } from "@verify/shared";

/**
 * The language to switch to for a session in `locale`, or null to keep the current one.
 * `explicit` is the rider's own choice, if any.
 */
export function sessionLanguage(locale: string | null, explicit: Language | null, current: string): Language | null {
  if (explicit || !isSupportedLanguage(locale) || locale === current) return null;
  return locale;
}
