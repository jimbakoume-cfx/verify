import i18next, { type Resource } from "i18next";
import { initReactI18next } from "react-i18next";
import { isSupportedLanguage, pickLanguage, type Language } from "./language";

const STORAGE_KEY = "verify.lang";

function readStoredLanguage(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Initialise translations for an app. Each app passes its own FR/EN strings. */
export function initI18n(resources: Resource) {
  const urlLang = new URLSearchParams(window.location.search).get("lang");
  const lng = pickLanguage(urlLang ?? readStoredLanguage(), navigator.languages ?? []);
  document.documentElement.lang = lng;
  void i18next.use(initReactI18next).init({
    resources,
    lng,
    fallbackLng: "fr",
    interpolation: { escapeValue: false },
  });
  return i18next;
}

export function changeLanguage(lng: Language) {
  try {
    window.localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    // Private browsing: the choice just isn't remembered.
  }
  document.documentElement.lang = lng;
  return i18next.changeLanguage(lng);
}

/**
 * The language the user chose explicitly: `?lang=` in the link, or the toggle (remembered).
 * Null when the language only comes from the device settings.
 */
export function explicitLanguage(): Language | null {
  const normalise = (tag: string | null) => tag?.trim().toLowerCase().split(/[-_]/)[0] ?? null;
  for (const tag of [new URLSearchParams(window.location.search).get("lang"), readStoredLanguage()]) {
    const lng = normalise(tag);
    if (isSupportedLanguage(lng)) return lng;
  }
  return null;
}

/** Shows `lng` without remembering it as the user's choice (e.g. a session's language). */
export function showLanguage(lng: Language) {
  document.documentElement.lang = lng;
  return i18next.changeLanguage(lng);
}
