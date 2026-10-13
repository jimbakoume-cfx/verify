import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Footer, TopBar } from "../components/Chrome";

/** A one-card page: loading, not configured, no staff access, or a failure with retry. */
export function MessageScreen({
  title,
  children,
  onSignOut,
  busy = false,
}: {
  title: string;
  children?: ReactNode;
  onSignOut?: () => void;
  busy?: boolean;
}) {
  return (
    <main className="page">
      <TopBar onSignOut={onSignOut} />
      <section className="card dash-auth" aria-busy={busy || undefined}>
        <h1>{title}</h1>
        {children}
      </section>
      <Footer />
    </main>
  );
}

export function LoadingScreen() {
  const { t } = useTranslation();
  return <MessageScreen title={t("loading")} busy />;
}

export function NotConfiguredScreen() {
  const { t } = useTranslation();
  return (
    <MessageScreen title={t("notConfigured.title")}>
      <p>{t("notConfigured.body")}</p>
    </MessageScreen>
  );
}

export function NoAccessScreen({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const { t } = useTranslation();
  return (
    <MessageScreen title={t("noAccess.title")} onSignOut={onSignOut}>
      <p>{t("noAccess.body", { email })}</p>
      <p className="muted">{t("noAccess.next")}</p>
    </MessageScreen>
  );
}
