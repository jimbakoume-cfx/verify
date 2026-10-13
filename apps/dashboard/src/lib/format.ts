import type { Language } from "@verify/shared";

// Cameroonian locales: French and English as spoken there (CLDR has both).
const LOCALE: Record<Language, string> = { fr: "fr-CM", en: "en-CM" };

export function toLanguage(value: string | undefined): Language {
  return value?.startsWith("en") ? "en" : "fr";
}

export function formatDateTime(iso: string | null, lang: Language): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** Size in kilobytes (1 kB = 1000 bytes, as the 300 kB capture target is stated). FR writes "ko". */
export function formatBytes(bytes: number, lang: Language): string {
  const kb = bytes / 1000;
  const digits = kb < 10 ? 1 : 0;
  const value = new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: digits }).format(kb);
  return `${value} ${lang === "fr" ? "ko" : "kB"}`;
}

export function formatNumber(value: number | null, lang: Language, fractionDigits = 0): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: fractionDigits }).format(value);
}

/** A 0..1 ratio as a percentage. */
export function formatPercent(ratio: number | null, lang: Language, fractionDigits = 0): string {
  if (ratio === null) return "—";
  return new Intl.NumberFormat(LOCALE[lang], { style: "percent", maximumFractionDigits: fractionDigits }).format(ratio);
}

export function formatDimensions(width: number | null, height: number | null): string {
  return width !== null && height !== null ? `${width} × ${height}` : "—";
}

/** First 8 characters of an id or hash: enough to tell rows apart on screen. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
