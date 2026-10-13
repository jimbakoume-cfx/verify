// Small building blocks shared by the rider screens.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Brand, LanguageToggle } from "@verify/shared";
import { type FlowErrorCode, errorMessageKey } from "./flow/errors";

/** The light page used by every screen except the camera (Confiance top bar, centred column). */
export function Page({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <main className={`page ${className}`.trim()}>
      <header className="topbar">
        <Brand product="Verify" />
        <LanguageToggle />
      </header>
      {children}
    </main>
  );
}

/** Screen title. It takes focus when the screen appears, so screen readers announce the new step. */
export function ScreenTitle({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <h1 ref={ref} tabIndex={-1}>
      {children}
    </h1>
  );
}

export function ErrorNotice({ code }: { code: FlowErrorCode }) {
  const { t } = useTranslation();
  return (
    <p className="notice error" role="alert">
      {t(errorMessageKey(code))}
    </p>
  );
}

/** An object URL for `blob`, revoked when the blob changes or the component goes away. */
export function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      setUrl(null);
    };
  }, [blob]);
  return url;
}

export function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
