import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DECLARED_DOCUMENTS, REQUIRED_SIDES, type DeclaredDocument } from "@verify/shared";
import type { FlowErrorCode } from "../flow/errors";
import { ErrorNotice, Page, ScreenTitle } from "../ui";

interface Props {
  /** Pre-selected when the rider comes back (e.g. "Back" from the camera). */
  initial: DeclaredDocument | null;
  busy: boolean;
  error: FlowErrorCode | null;
  onChoose: (document: DeclaredDocument) => void;
}

export function DocumentChoiceScreen({ initial, busy, error, onChoose }: Props) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<DeclaredDocument | null>(initial);
  return (
    <Page>
      <ScreenTitle>{t("document.title")}</ScreenTitle>
      <p className="muted">{t("document.intro")}</p>

      <fieldset className="choices" disabled={busy}>
        <legend className="sr-only">{t("document.title")}</legend>
        {DECLARED_DOCUMENTS.map((doc) => (
          <label key={doc} className="choice">
            <input type="radio" name="document" value={doc} checked={choice === doc} onChange={() => setChoice(doc)} />
            <span className="choice-text">
              <span className="choice-name">{t(`documents.${doc}`)}</span>
              <span className="choice-sub">
                {REQUIRED_SIDES[doc].length > 1 ? t("document.bothSides") : t("document.photoPage")}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {error && <ErrorNotice code={error} />}

      <button type="button" className="primary" disabled={!choice || busy} onClick={() => choice && onChoose(choice)}>
        {busy ? t("common.saving") : t("document.continue")}
      </button>
    </Page>
  );
}
