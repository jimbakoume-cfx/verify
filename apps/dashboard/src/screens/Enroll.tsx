import { type FormEvent, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type EnrollRequest,
  STAFF_PASSWORD_MAX_BYTES,
  STAFF_PASSWORD_MAX_LENGTH,
  STAFF_PASSWORD_MIN_LENGTH,
  passwordByteLength,
} from "@verify/shared";
import { Footer, TopBar } from "../components/Chrome";
import { checkPassword, passwordAcceptable, passwordLength } from "../lib/password";

export interface EnrollValues {
  email: string;
  code: string;
  password: string;
  confirmation: string;
}

export interface EnrollProps {
  initial?: Partial<EnrollValues>;
  /** i18n key of an error to show from the start (dev screen preview). */
  initialError?: string | null;
  /** Resolves to an i18n error key, or null once the account exists (the app then signs in). */
  onEnroll: (request: EnrollRequest) => Promise<string | null>;
  onBack: (email: string) => void;
}

function Rule({ met, children }: { met: boolean; children: string }) {
  const { t } = useTranslation();
  return (
    <li className={met ? "met" : undefined}>
      <span className="dash-rule-icon" aria-hidden="true">
        {met ? "✓" : "•"}
      </span>
      {children}
      <span className="visually-hidden">{met ? t("enroll.ruleMet") : t("enroll.ruleNotMet")}</span>
    </li>
  );
}

export function EnrollScreen({ initial, initialError = null, onEnroll, onBack }: EnrollProps) {
  const { t } = useTranslation();
  const rulesId = useId();
  const [values, setValues] = useState<EnrollValues>({
    email: initial?.email ?? "",
    code: initial?.code ?? "",
    password: initial?.password ?? "",
    confirmation: initial?.confirmation ?? "",
  });
  const [showPasswords, setShowPasswords] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);

  const rules = checkPassword(values.password, values.confirmation, values.email);
  const ready = passwordAcceptable(rules) && values.email.trim() !== "" && values.code.trim() !== "";
  const set = (field: keyof EnrollValues) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [field]: e.target.value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    const errorKey = await onEnroll({ email: values.email.trim(), code: values.code, password: values.password });
    if (errorKey) {
      setError(errorKey);
      setBusy(false);
    }
  }

  const passwordType = showPasswords ? "text" : "password";
  return (
    <main className="page">
      <TopBar />
      <section className="card dash-auth">
        <h1>{t("enroll.title")}</h1>
        <p className="muted">{t("enroll.intro")}</p>
        <form className="dash-form" onSubmit={(e) => void submit(e)}>
          <label className="field">
            <span>{t("fields.email")}</span>
            <input
              type="email"
              name="email"
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={values.email}
              onChange={set("email")}
            />
          </label>
          <label className="field">
            <span>{t("fields.inviteCode")}</span>
            <input
              type="text"
              name="invite-code"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              required
              value={values.code}
              onChange={set("code")}
            />
            <span className="hint">{t("enroll.codeHint")}</span>
          </label>
          <label className="field">
            <span>{t("fields.newPassword")}</span>
            <input
              type={passwordType}
              name="new-password"
              autoComplete="new-password"
              required
              aria-describedby={rulesId}
              value={values.password}
              onChange={set("password")}
            />
          </label>
          <label className="field">
            <span>{t("fields.confirmPassword")}</span>
            <input
              type={passwordType}
              name="confirm-password"
              autoComplete="new-password"
              required
              aria-describedby={rulesId}
              value={values.confirmation}
              onChange={set("confirmation")}
            />
          </label>
          <label className="dash-check">
            <input type="checkbox" checked={showPasswords} onChange={(e) => setShowPasswords(e.target.checked)} />
            <span>{t("enroll.showPasswords")}</span>
          </label>
          <ul className="dash-rules" id={rulesId}>
            <Rule met={rules.length}>
              {t("enroll.ruleLength", {
                min: STAFF_PASSWORD_MIN_LENGTH,
                max: STAFF_PASSWORD_MAX_LENGTH,
                length: passwordLength(values.password),
              })}
            </Rule>
            <Rule met={rules.bytes}>
              {t("enroll.ruleBytes", { maxBytes: STAFF_PASSWORD_MAX_BYTES, bytes: passwordByteLength(values.password) })}
            </Rule>
            <Rule met={rules.notEmailName}>{t("enroll.ruleNotEmailName")}</Rule>
            <Rule met={rules.matches}>{t("enroll.ruleMatches")}</Rule>
          </ul>
          {error && (
            <p className="dash-alert error" role="alert">
              {t(error, { min: STAFF_PASSWORD_MIN_LENGTH, max: STAFF_PASSWORD_MAX_LENGTH, maxBytes: STAFF_PASSWORD_MAX_BYTES })}
            </p>
          )}
          <button type="submit" className="primary" disabled={busy || !ready}>
            {busy ? t("enroll.busy") : t("enroll.submit")}
          </button>
        </form>
        <button type="button" className="dash-link-button" onClick={() => onBack(values.email)}>
          {t("enroll.back")}
        </button>
      </section>
      <Footer />
    </main>
  );
}
