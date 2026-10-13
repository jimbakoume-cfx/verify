import { useTranslation } from "react-i18next";
import { changeLanguage } from "./i18n";
import { SUPPORTED_LANGUAGES } from "./language";

export function LanguageToggle() {
  const { i18n } = useTranslation();
  return (
    <div className="lang-toggle" role="group" aria-label="Langue / Language">
      {SUPPORTED_LANGUAGES.map((lng) => (
        <button
          key={lng}
          type="button"
          aria-pressed={i18n.language === lng}
          onClick={() => void changeLanguage(lng)}
        >
          {lng.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
