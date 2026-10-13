import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Footer, TopBar } from "../components/Chrome";

export interface SignInProps {
  initialEmail?: string;
  /** i18n key of an information message, e.g. after an account was set up. */
  notice?: string | null;
  /** i18n key of an error to show from the start (dev screen preview). */
  initialError?: string | null;
  /** Resolves to an i18n error key, or null once signed in. */
  onSignIn: (email: string, password: string) => Promise<string | null>;
  onSetUp: (email: string) => void;
}

export function SignInScreen({ initialEmail = "", notice, initialError = null, onSignIn, onSetUp }: SignInProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const errorKey = await onSignIn(email, password);
    // On success this screen is replaced; only a failure needs the form back.
    if (errorKey) {
      setError(errorKey);
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <TopBar />
      <section className="card dash-auth">
        <h1>{t("signIn.title")}</h1>
        <p className="muted">{t("signIn.intro")}</p>
        {notice && (
          <p className="dash-alert ok" role="status">
            {t(notice)}
          </p>
        )}
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
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            <span>{t("fields.password")}</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <p className="dash-alert error" role="alert">
              {t(error)}
            </p>
          )}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? t("signIn.busy") : t("signIn.submit")}
          </button>
        </form>
      </section>

      <section className="card dash-auth">
        <h2>{t("signIn.firstTimeTitle")}</h2>
        <p className="muted">{t("signIn.firstTimeBody")}</p>
        <button type="button" onClick={() => onSetUp(email)}>
          {t("signIn.setUp")}
        </button>
        <p className="muted dash-small">{t("signIn.forgotten")}</p>
      </section>
      <Footer />
    </main>
  );
}
