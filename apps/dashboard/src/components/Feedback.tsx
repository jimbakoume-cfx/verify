import { useTranslation } from "react-i18next";
import type { FlowStatus } from "@verify/shared";
import { type ErrorContext, errorMessageKey, toClientError } from "../lib/errors";

export function ErrorText({ error, context = "default" }: { error: unknown; context?: ErrorContext }) {
  const { t } = useTranslation();
  return (
    <p className="dash-alert error" role="alert">
      {t(errorMessageKey(toClientError(error).code, context))}
    </p>
  );
}

const STATUS_TONE: Record<FlowStatus, "neutral" | "info" | "ok" | "warn" | "bad"> = {
  created: "neutral",
  in_progress: "info",
  submitted: "info",
  processing: "info",
  in_review: "warn",
  approved: "ok",
  rejected: "bad",
  expired: "neutral",
  cancelled: "neutral",
};

export function StatusBadge({ status }: { status: FlowStatus }) {
  const { t } = useTranslation();
  return <span className={`badge ${STATUS_TONE[status]}`}>{t(`status.${status}`)}</span>;
}

export function TestBadge() {
  const { t } = useTranslation();
  return <span className="badge test">{t("badges.test")}</span>;
}
