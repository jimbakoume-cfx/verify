import { useTranslation } from "react-i18next";
import { Page, ScreenTitle } from "../ui";

/** Front of a card, a turning arrow, then its back (MRZ-like lines). */
function FlipIllustration() {
  return (
    <svg className="illustration" viewBox="0 0 232 112" aria-hidden="true" focusable="false">
      <rect x="6" y="14" width="96" height="61" rx="6" fill="var(--brand-soft)" stroke="var(--brand)" strokeWidth="3" />
      <rect x="16" y="28" width="22" height="28" rx="3" fill="var(--brand)" opacity="0.35" />
      <rect x="46" y="30" width="44" height="6" rx="3" fill="var(--brand)" opacity="0.35" />
      <rect x="46" y="44" width="34" height="6" rx="3" fill="var(--brand)" opacity="0.35" />
      <rect x="130" y="14" width="96" height="61" rx="6" fill="#fff" stroke="var(--brand)" strokeWidth="3" />
      <rect x="140" y="50" width="76" height="5" rx="2.5" fill="var(--brand)" opacity="0.45" />
      <rect x="140" y="60" width="76" height="5" rx="2.5" fill="var(--brand)" opacity="0.45" />
      <path d="M58 92c30 20 86 20 116 0" fill="none" stroke="var(--ok)" strokeWidth="4" strokeLinecap="round" />
      <path d="M163 86l11 6-9 9" fill="none" stroke="var(--ok)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TurnOverScreen({ onContinue }: { onContinue: () => void }) {
  const { t } = useTranslation();
  return (
    <Page>
      <ScreenTitle>{t("turnOver.title")}</ScreenTitle>
      <section className="card center">
        <FlipIllustration />
        <p>{t("turnOver.body")}</p>
      </section>
      <button type="button" className="primary" onClick={onContinue}>
        {t("turnOver.continue")}
      </button>
    </Page>
  );
}
