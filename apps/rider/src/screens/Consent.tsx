import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { FlowErrorCode } from "../flow/errors";
import { ErrorNotice, Page, ScreenTitle } from "../ui";

/** Sections of the placeholder text, in reading order (keys under `consent.`). */
const SECTIONS = ["what", "why", "how", "keep", "rights"] as const;

interface Props {
  busy: boolean;
  error: FlowErrorCode | null;
  /** `keepFaceImages`: the separate, optional box (M5, PM decision), unticked by default. */
  onAccept: (keepFaceImages: boolean) => void;
  onDecline: () => void;
}

export function ConsentScreen({ busy, error, onAccept, onDecline }: Props) {
  const { t } = useTranslation();
  const [agreed, setAgreed] = useState(false);
  const [keepFaces, setKeepFaces] = useState(false);
  return (
    <Page>
      <ScreenTitle>{t("consent.title")}</ScreenTitle>

      <div className="notice warn placeholder" role="note">
        <span className="badge warn">{t("consent.placeholderBadge")}</span>
        <span>{t("consent.placeholderNote")}</span>
      </div>

      <section className="card consent-text">
        {SECTIONS.map((key) => (
          <div key={key}>
            <h2>{t(`consent.${key}Title`)}</h2>
            <p>{t(`consent.${key}`)}</p>
          </div>
        ))}
      </section>

      <label className="check">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} disabled={busy} />
        <span>{t("consent.checkbox")}</span>
      </label>

      {/* Separate and optional: the verification goes ahead whatever the answer. Placeholder wording. */}
      <label className="check optional">
        <input type="checkbox" checked={keepFaces} onChange={(e) => setKeepFaces(e.target.checked)} disabled={busy} />
        <span>
          {t("consent.keepFaces")} <span className="muted">{t("consent.keepFacesOptional")}</span>
        </span>
      </label>

      {error && <ErrorNotice code={error} />}

      <div className="actions">
        <button type="button" className="primary" disabled={!agreed || busy} onClick={() => onAccept(keepFaces)}>
          {busy ? t("common.saving") : t("consent.accept")}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onDecline}>
          {t("consent.decline")}
        </button>
      </div>
    </Page>
  );
}

export function DeclinedScreen({ onReview }: { onReview: () => void }) {
  const { t } = useTranslation();
  return (
    <Page>
      <ScreenTitle>{t("declined.title")}</ScreenTitle>
      <section className="card">
        <p>{t("declined.body")}</p>
        <p className="muted">{t("declined.hint")}</p>
      </section>
      <button type="button" className="secondary" onClick={onReview}>
        {t("declined.review")}
      </button>
    </Page>
  );
}
