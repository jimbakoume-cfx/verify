import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type CopyState = "idle" | "copied" | "failed";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Copies `text`; the result is announced to screen readers through a polite live region. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state !== "copied") return;
    const id = window.setTimeout(() => setState("idle"), 2500);
    return () => window.clearTimeout(id);
  }, [state]);

  return (
    <div className="dash-copy">
      <button type="button" onClick={() => void copyText(text).then((ok) => setState(ok ? "copied" : "failed"))}>
        {label}
      </button>
      <span className={`dash-copy-status ${state}`} role="status" aria-live="polite">
        {state === "copied" ? t("copy.copied") : state === "failed" ? t("copy.failed") : ""}
      </span>
    </div>
  );
}
