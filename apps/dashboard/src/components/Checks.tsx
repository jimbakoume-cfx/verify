// Small pieces shared by the sections that show check results (code lines, server checks).
import { useTranslation } from "react-i18next";
import type { MrzCheckLine } from "../lib/mrz";
import type { CheckOutcome } from "../lib/records";

const OUTCOME_TONE: Record<CheckOutcome, "neutral" | "ok" | "warn" | "bad"> = {
  pass: "ok",
  flag: "warn",
  fail: "bad",
  error: "bad",
  skipped: "neutral",
};

/** Passed, To check…: the outcome stored with a check. */
export function OutcomeBadge({ outcome }: { outcome: CheckOutcome }) {
  const { t } = useTranslation();
  return <span className={`badge ${OUTCOME_TONE[outcome]}`}>{t(`checkOutcome.${outcome}`)}</span>;
}

/** Not tuned on real documents yet: shown for information, never decides on its own. */
export function ProvisionalBadge() {
  const { t } = useTranslation();
  return <span className="badge warn">{t("serverChecks.provisional")}</span>;
}

/**
 * ✅/❌ lines, "—" when the result does not say. The icon is hidden from screen readers, which hear
 * "passed", "failed" or "not available" after the label instead.
 */
export function CheckLines({ lines }: { lines: readonly MrzCheckLine[] }) {
  const { t } = useTranslation();
  return (
    <ul className="dash-mrz-checks">
      {lines.map((line) => (
        <li key={line.key} className={line.ok === null ? "unknown" : line.ok ? "ok" : "bad"}>
          <span className="dash-mrz-icon" aria-hidden="true">
            {line.ok === null ? "—" : line.ok ? "✅" : "❌"}
          </span>
          <span>
            {t(line.key)}
            <span className="visually-hidden">
              {", "}
              {t(line.ok === null ? "mrz.tick.unknown" : line.ok ? "mrz.tick.ok" : "mrz.tick.bad")}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
