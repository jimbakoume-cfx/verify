// A render error, or a lazy chunk that fails to load, must never leave the rider a blank page.
// Typical causes on phones: the network drops while the camera code downloads, or the site was
// redeployed during a session and the old chunk is gone.
import { Component, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  children: ReactNode;
  /** What to show instead of the children once one of them failed to render. */
  fallback: ReactNode;
}

export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Last resort around the whole app: a reload keeps the session (sessionStorage). */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return <ErrorBoundary fallback={<FatalError />}>{children}</ErrorBoundary>;
}

function FatalError() {
  const { t } = useTranslation();
  return (
    <main className="page">
      <section className="card" role="alert">
        <h1>{t("fatal.title")}</h1>
        <p>{t("fatal.text")}</p>
        <button type="button" className="primary" onClick={() => window.location.reload()}>
          {t("fatal.reload")}
        </button>
      </section>
    </main>
  );
}
