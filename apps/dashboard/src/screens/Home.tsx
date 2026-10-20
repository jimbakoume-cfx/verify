import { useMemo, useState } from "react";
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
import { debugRiderUrl } from "../lib/riderLink";
import { filterQueue, type QueueFilter, type QueueSort, sortQueue } from "../lib/risk";
import { canCreateTestSessions, seesAllVerifications } from "../lib/roles";
import { casePath } from "../lib/routes";
import { parseTime } from "../lib/time";
import { formatScore, RecommendationBadge } from "./CaseRisk";

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
  // Same session with ?debug=1: the phone also shows what it measured and read (test sessions only).
  const debugUrl = session ? debugRiderUrl(session.riderUrl) : null;

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
          <div className="dash-qr-codes">
            <figure className="dash-qr-figure">
              <div className="dash-qr-box">
                <QrCode value={session.riderUrl} label={t("testSession.qrLabel")} />
              </div>
              <figcaption>{t("testSession.linkLabel")}</figcaption>
            </figure>
            {debugUrl && (
              <figure className="dash-qr-figure">
                <div className="dash-qr-box">
                  <QrCode value={debugUrl} label={t("testSession.debugQrLabel")} />
                </div>
                <figcaption>{t("testSession.debugLabel")}</figcaption>
              </figure>
            )}
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
            {debugUrl && (
              <>
                <p className="muted dash-small">{t("testSession.debugHint")}</p>
                <CopyButton text={debugUrl} label={t("testSession.copyDebug")} />
              </>
            )}
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
  // M8: the queue sorted by the rules' recommendation (cases waiting for a decision first).
  const [sort, setSort] = useState<QueueSort>("newest");
  // Automatic approval: the cases the system approved on its own, for staff to check afterwards.
  const [filter, setFilter] = useState<QueueFilter>("all");
  const sorted = useMemo(() => (items ? sortQueue(filterQueue(items, filter), sort) : undefined), [items, sort, filter]);

  return (
    <section className="card" aria-labelledby="recent-title" aria-busy={loading || undefined}>
      <div className="dash-section-head">
        <h2 id="recent-title">{t("recent.title")}</h2>
        <span className="dash-row-badges">
          <label className="dash-sort">
            <span>{t("recent.sortLabel")}</span>
            <select value={sort} onChange={(e) => setSort(e.target.value === "recommendation" ? "recommendation" : "newest")}>
              <option value="newest">{t("recent.sort.newest")}</option>
              <option value="recommendation">{t("recent.sort.recommendation")}</option>
            </select>
          </label>
          <label className="dash-sort">
            <span>{t("recent.filterLabel")}</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value === "autoApproved" ? "autoApproved" : "all")}>
              <option value="all">{t("recent.filter.all")}</option>
              <option value="autoApproved">{t("recent.filter.autoApproved")}</option>
            </select>
          </label>
          <button type="button" className="small" onClick={onReload} disabled={loading}>
            {loading ? t("loading") : t("recent.refresh")}
          </button>
        </span>
      </div>
      {assignedOnly && <p className="muted">{t("recent.assignedOnly")}</p>}
      {error !== null && error !== undefined && <ErrorText error={error} />}
      {items && items.length === 0 && <p className="muted">{t("recent.empty")}</p>}
      {items && items.length > 0 && sorted?.length === 0 && <p className="muted">{t("recent.filterEmpty")}</p>}
      {sorted && sorted.length > 0 && (
        <ul className="dash-list">
          {sorted.map((v) => (
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
                  {v.risk.autoApprovedAt && (
                    <span className="badge info">
                      {t("recent.autoApproved", { version: v.risk.thresholdVersion ?? "—" })}
                    </span>
                  )}
                  {v.status === "submitted" && v.risk.recommendation && (
                    <span className="dash-row-risk" title={t("risk.score")}>
                      <RecommendationBadge outcome={v.risk.recommendation} />
                      {v.risk.score !== null && <span className="muted dash-small">{formatScore(v.risk.score, lang)}</span>}
                    </span>
                  )}
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
