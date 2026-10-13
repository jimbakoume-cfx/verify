export const SUPPORTED_LANGUAGES = ["fr", "en"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** French is the majority language in Cameroon, so it is the fallback. */
export const DEFAULT_LANGUAGE: Language = "fr";

export function isSupportedLanguage(value: unknown): value is Language {
  return typeof value === "string" && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Decide which language to show.
 * Priority: explicit choice (e.g. ?lang=en from the ride app, or the user's toggle),
 * then the phone's language settings, then French.
 */
export function pickLanguage(explicit: string | null | undefined, browserLanguages: readonly string[]): Language {
  const normalise = (tag: string) => tag.trim().toLowerCase().split(/[-_]/)[0];
  if (explicit && isSupportedLanguage(normalise(explicit))) {
    return normalise(explicit) as Language;
  }
  for (const tag of browserLanguages) {
    const base = normalise(tag);
    if (isSupportedLanguage(base)) return base;
  }
  return DEFAULT_LANGUAGE;
}
