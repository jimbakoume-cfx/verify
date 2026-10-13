import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TestSessionResponse } from "@verify/shared";
import { useServices } from "../api/services";
import { CopyButton } from "../components/CopyButton";
import { Countdown } from "../components/Countdown";
import { ErrorText, StatusBadge, TestBadge } from "../components/Feedback";
import { Link } from "../components/Link";
import { QrCode } from "../components/QrCode";
import { useAsync, useNow } from "../hooks";
import { formatDateTime, shortId, toLanguage } from "../lib/format";
import { type StaffProfile, sessionOpen, type VerificationListItem } from "../lib/records";
import { canCreateTestSessions, seesAllVerifications } from "../lib/roles";
import { casePath } from "../lib/routes";
import { parseTime } from "../lib/time";

export interface HomeProps {
  profile: StaffProfile;
  /** Kept by the parent so the QR code survives a visit to a case page (never stored). */
  testSession: TestSessionResponse | null;
  onTestSession: (session: TestSessionResponse) => void;
}

export function Home({ profile, testSession, onTestSession }: HomeProps) {
  const services = useServices();
  const recent = useAsync(() => services.recentVerifications(), "recent");

  return (
    <>
      {canCreateTestSessions(profile.role) && (
        <TestSessionPanel
          session={testSession}
          onCreated={(session) => {
            onTestSession(session);
            recent.reload();
          }}
        />
      )}
      <RecentVerifications
        items={recent.data}
        error={recent.error}
        loading={recent.loading}
        onReload={recent.reload}
        assignedOnly={!seesAllVerifications(profile.role)}
      />
    </>
  );
}

function TestSessionPanel({
  session,
  onCreated,
}: {
  session: TestSessionResponse | null;
  onCreated: (session: TestSessionResponse) => void;
}) {
  const { t, i18n } = useTranslation();
  const services = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const deadline = session ? parseTime(session.expiresAt) : Number.NaN;
  // Ticks only while the link is live, to grey the QR code out once it expires.
  const now = useNow(1000, session !== null && deadline > Date.now());
  const expired = session !== null && !(deadline > now);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      onCreated(await services.createTestSession({ locale: toLanguage(i18n.language) }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="test-sessions-title">
      <div className="dash-section-head">
        <h2 id="test-sessions-title">{t("testSession.title")}</h2>
        <button type="button" className="primary dash-inline" onClick={() => void create()} disabled={busy}>
          {busy ? t("testSession.creating") : t("testSession.create")}
        </button>
      </div>
      <p className="muted">{t("testSession.intro")}</p>
      {error !== null && <ErrorText error={error} context="testSession" />}

      {session && (
        <div className={`dash-test-session${expired ? " expired" : ""}`}>
          <div className="dash-qr-box">
            <QrCode value={session.riderUrl} label={t("testSession.qrLabel")} />
          </div>
          <div className="dash-test-session-body">
            <p>{t("testSession.scan")}</p>
            <label className="field">
              <span>{t("testSession.linkLabel")}</span>
              <input
                type="text"
                readOnly
                value={session.riderUrl}
                spellCheck={false}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <CopyButton text={session.riderUrl} label={t("testSession.copy")} />
            <Countdown deadlineMs={deadline} runningKey="testSession.expiresIn" expiredKey="testSession.expired" />
            <Link href={casePath(session.verificationId)}>{t("testSession.openCase")}</Link>
          </div>
        </div>
      )}
    </section>
  );
}

function RecentVerifications({
  items,
  error,
  loading,
  onReload,
  assignedOnly,
}: {
  items: VerificationListItem[] | undefined;
  error: unknown;
  loading: boolean;
  onReload: () => void;
  assignedOnly: boolean;
}) {
  const { t, i18n } = useTranslation();
  const lang = toLanguage(i18n.language);
  const now = useNow(30_000);

  return (
    <section className="card" aria-labelledby="recent-title" aria-busy={loading || undefined}>
      <div className="dash-section-head">
        <h2 id="recent-title">{t("recent.title")}</h2>
        <button type="button" className="small" onClick={onReload} disabled={loading}>
          {loading ? t("loading") : t("recent.refresh")}
        </button>
      </div>
      {assignedOnly && <p className="muted">{t("recent.assignedOnly")}</p>}
      {error !== null && error !== undefined && <ErrorText error={error} />}
      {items && items.length === 0 && <p className="muted">{t("recent.empty")}</p>}
      {items && items.length > 0 && (
        <ul className="dash-list">
          {items.map((v) => (
            <li key={v.id}>
              <Link href={casePath(v.id)} className="dash-row">
                <span className="dash-row-main">
                  <span className="dash-row-title">
                    {v.declaredDocument ? t(`documents.${v.declaredDocument}`) : t("recent.noDocument")}
                  </span>
                  <span className="dash-row-meta">
                    {formatDateTime(v.createdAt, lang)} · <span className="mono">{shortId(v.id)}</span>
                  </span>
                </span>
                <span className="dash-row-badges">
                  <StatusBadge status={v.status} />
                  {v.isTest && <TestBadge />}
                  {(v.status === "created" || v.status === "in_progress") && !sessionOpen(v, now) && (
                    <span className="badge neutral">{t("badges.linkExpired")}</span>
                  )}
                </span>
                <span className="dash-row-count">{t("recent.photos", { count: v.captureCount })}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
