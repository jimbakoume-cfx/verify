import { useTranslation } from "react-i18next";
import { useNow } from "../hooks";
import { formatCountdown, secondsLeft } from "../lib/time";

/**
 * "Expires in m:ss" until `deadlineMs`, then the expired text. role="timer" is not announced on
 * every tick; the switch to the expired text is, through role="status".
 */
export function Countdown({
  deadlineMs,
  runningKey,
  expiredKey,
}: {
  deadlineMs: number;
  /** i18n key with a {{time}} placeholder. */
  runningKey: string;
  expiredKey: string;
}) {
  const { t } = useTranslation();
  const now = useNow(1000, Number.isFinite(deadlineMs) && deadlineMs > Date.now());
  const left = secondsLeft(deadlineMs, now);
  if (left === 0) {
    return (
      <p className="dash-countdown expired" role="status">
        {t(expiredKey)}
      </p>
    );
  }
  return (
    <p className={`dash-countdown${left <= 60 ? " soon" : ""}`} role="timer">
      {t(runningKey, { time: formatCountdown(left) })}
    </p>
  );
}
