import i18next, { type Resource } from "i18next";
import { initReactI18next } from "react-i18next";
import { pickLanguage, type Language } from "./language";

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
