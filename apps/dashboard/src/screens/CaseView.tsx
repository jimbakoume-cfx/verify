import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Language } from "@verify/shared";
import { useServices } from "../api/services";
import { ErrorText, StatusBadge, TestBadge } from "../components/Feedback";
import type { OpenDocumentData } from "../components/DocumentDataViewer";
import { Link } from "../components/Link";
import { type OpenPhoto, PhotoViewer } from "../components/PhotoViewer";
import { useAsync, useNow } from "../hooks";
import {
  formatBytes,
  formatDateTime,
  formatDimensions,
  formatNumber,
  formatPercent,
  shortId,
  toLanguage,
} from "../lib/format";
import { type CaptureRecord, sessionOpen, sortCaptures, type StaffProfile, type VerificationSummary } from "../lib/records";
import { phoneLinesRead } from "../lib/mrz";
import { photoAccess } from "../lib/roles";
import { mayHaveDocumentData } from "../lib/serverChecks";
import { DocumentDataSection } from "./CaseData";
import { MrzSection } from "./CaseMrz";
import { ServerChecksSection } from "./CaseServer";

export interface CaseViewProps {
  id: string;
  profile: StaffProfile;
  /** Photos already open (dev screen preview only). */
  initialPhotos?: Record<string, OpenPhoto>;
  /** Data read already shown (dev screen preview only). */
  initialDocumentData?: OpenDocumentData;
}

export function CaseView({ id, profile, initialPhotos, initialDocumentData }: CaseViewProps) {
  const { t } = useTranslation();
  const services = useServices();
  const state = useAsync(
    async () => {
      const [verification, captures] = await Promise.all([services.verification(id), services.captures(id)]);
      return { verification, captures: sortCaptures(captures) };
    },
    `case:${id}`,
  );
  // Each loaded on its own, so a failure there leaves the rest of the case readable.
  const mrz = useAsync(() => services.mrzChecks(id), `mrz:${id}`);
  const server = useAsync(() => services.serverChecks(id), `server:${id}`);
  const reloadAll = () => {
    state.reload();
    mrz.reload();
    server.reload();
  };
  const mayHaveData = useMemo(
    () => mayHaveDocumentData(mrz.data ? phoneLinesRead(mrz.data) : false, server.data),
    [mrz.data, server.data],
  );

  return (
    <>
      <nav>
        <Link href="/" className="dash-back">
          ← {t("case.back")}
        </Link>
      </nav>
      {state.loading && !state.data && (
        <section className="card" aria-busy="true">
          <p className="muted">{t("loading")}</p>
        </section>
      )}
      {state.error !== null && state.error !== undefined && (
        <section className="card">
          <ErrorText error={state.error} />
          <button type="button" onClick={state.reload}>
            {t("retry")}
          </button>
        </section>
      )}
      {state.data && !state.data.verification && (
        <section className="card">
          <h1>{t("case.notFoundTitle")}</h1>
          <p>{t("case.notFoundBody")}</p>
        </section>
      )}
      {state.data?.verification && (
        <>
          <CaseSummary verification={state.data.verification} />
          <ServerChecksSection
            verification={state.data.verification}
            captures={state.data.captures}
            checks={server.data}
            error={server.error}
            loading={server.loading}
            onReload={reloadAll}
          />
          <MrzSection
            verification={state.data.verification}
            captures={state.data.captures}
            checks={mrz.data}
            error={mrz.error}
            loading={mrz.loading}
            onReload={reloadAll}
          />
          <DocumentDataSection
            verificationId={state.data.verification.id}
            captures={state.data.captures}
            mayHaveData={mayHaveData}
            profile={profile}
            initialData={initialDocumentData}
          />
          <Captures
            captures={state.data.captures}
            profile={profile}
            initialPhotos={initialPhotos}
            onReload={reloadAll}
            reloading={state.loading}
          />
        </>
      )}
    </>
  );
}

function CaseSummary({ verification: v }: { verification: VerificationSummary }) {
  const { t, i18n } = useTranslation();
  const lang = toLanguage(i18n.language);
  const now = useNow(30_000);
  const linkState =
    v.status === "created" || v.status === "in_progress"
      ? sessionOpen(v, now)
        ? t("case.linkOpenUntil", { time: formatDateTime(v.sessionExpiresAt, lang) })
        : t("case.linkExpired")
      : t("case.linkUsed");

  return (
    <section className="card" aria-labelledby="case-title">
      <div className="dash-section-head">
        <h1 id="case-title">{t("case.title", { id: shortId(v.id) })}</h1>
        <span className="dash-row-badges">
          <StatusBadge status={v.status} />
          {v.isTest && <TestBadge />}
        </span>
      </div>
      <dl className="dash-facts">
        <div>
          <dt>{t("case.document")}</dt>
          <dd>{v.declaredDocument ? t(`documents.${v.declaredDocument}`) : t("recent.noDocument")}</dd>
        </div>
        <div>
          <dt>{t("case.created")}</dt>
          <dd>{formatDateTime(v.createdAt, lang)}</dd>
        </div>
        <div>
          <dt>{t("case.submitted")}</dt>
          <dd>{v.submittedAt ? formatDateTime(v.submittedAt, lang) : t("case.notSubmitted")}</dd>
        </div>
        <div>
          <dt>{t("case.riderLink")}</dt>
          <dd>{linkState}</dd>
        </div>
        <div className="dash-facts-wide">
          <dt>{t("case.reference")}</dt>
          <dd className="mono">{v.id}</dd>
        </div>
      </dl>
    </section>
  );
}

function Captures({
  captures,
  profile,
  initialPhotos,
  onReload,
  reloading,
}: {
  captures: CaptureRecord[];
  profile: StaffProfile;
  initialPhotos?: Record<string, OpenPhoto>;
  onReload: () => void;
  reloading: boolean;
}) {
  const { t, i18n } = useTranslation();
  const lang = toLanguage(i18n.language);

  return (
    <section className="card" aria-labelledby="photos-title">
      <div className="dash-section-head">
        <h2 id="photos-title">{t("case.photos")}</h2>
        <button type="button" className="small" onClick={onReload} disabled={reloading}>
          {reloading ? t("loading") : t("recent.refresh")}
        </button>
      </div>
      {captures.length === 0 ? (
        <p className="muted">{t("case.noPhotos")}</p>
      ) : (
        <>
          {photoAccess(profile.role) === "view" ? (
            <p className="muted dash-small">{t("case.viewsLogged")}</p>
          ) : (
            <p className="dash-alert info">{t("errors.adminNoImageAccess")}</p>
          )}
          <ul className="dash-captures">
            {captures.map((capture) => (
              <li key={capture.id}>
                <CaptureItem capture={capture} profile={profile} lang={lang} initialPhoto={initialPhotos?.[capture.id]} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

type PhotoState =
  | { status: "closed" }
  | { status: "opening" }
  | { status: "open"; photo: OpenPhoto }
  | { status: "expired" }
  | { status: "error"; error: unknown };

function CaptureItem({
  capture: c,
  profile,
  lang,
  initialPhoto,
}: {
  capture: CaptureRecord;
  profile: StaffProfile;
  lang: Language;
  initialPhoto?: OpenPhoto;
}) {
  const { t } = useTranslation();
  const services = useServices();
  const [photo, setPhoto] = useState<PhotoState>(initialPhoto ? { status: "open", photo: initialPhoto } : { status: "closed" });
  const kind = t(`kinds.${c.kind}`, { defaultValue: c.kind });
  const q = c.quality;

  async function open() {
    setPhoto({ status: "opening" });
    // Count the 60 s from before the request: the server's clock started no earlier than this.
    const requestedAt = Date.now();
    try {
      const view = await services.viewCapture(c.id);
      setPhoto({ status: "open", photo: { url: view.url, deadlineMs: requestedAt + view.expiresIn * 1000 } });
    } catch (error) {
      setPhoto({ status: "error", error });
    }
  }

  const facts: [string, string][] = [
    [t("capture.size"), formatBytes(c.byteSize, lang)],
    [t("capture.dimensions"), formatDimensions(c.width, c.height)],
    [t("capture.sharpness"), formatNumber(q.sharpness, lang)],
    [t("capture.glare"), formatPercent(q.glareRatio, lang, 1)],
    [t("capture.brightness"), q.meanLuma === null ? "—" : `${formatNumber(q.meanLuma, lang)} / 255`],
    [t("capture.framing"), formatPercent(q.framing, lang)],
    [t("capture.camera"), formatDimensions(q.videoWidth, q.videoHeight)],
    [t("capture.elapsed"), q.elapsedMs === null ? "—" : t("capture.seconds", { value: formatNumber(q.elapsedMs / 1000, lang, 1) })],
  ];

  return (
    <article className="dash-capture" aria-label={kind}>
      <header className="dash-capture-head">
        <h3>{kind}</h3>
        <span className="dash-row-badges">
          {q.source && <span className="badge neutral">{t(`capture.source.${q.source}`)}</span>}
          {q.reusedElsewhere === true && <span className="badge bad">{t("capture.reused")}</span>}
          {c.supersededBy && <span className="badge neutral">{t("capture.replaced")}</span>}
          {c.deleted && <span className="badge neutral">{t("capture.deleted")}</span>}
        </span>
      </header>
      <p className="muted dash-small">{formatDateTime(c.createdAt, lang)}</p>
      <dl className="dash-facts compact">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div className="dash-facts-wide">
          <dt>{t("capture.sha256")}</dt>
          <dd className="mono" title={c.sha256 || undefined}>
            {c.sha256 ? `${c.sha256.slice(0, 16)}…` : "—"}
          </dd>
        </div>
      </dl>

      {!c.deleted && photoAccess(profile.role) === "view" && photo.status !== "open" && (
        <div className="dash-capture-actions">
          <button type="button" onClick={() => void open()} disabled={photo.status === "opening"}>
            {photo.status === "opening" ? t("case.opening") : t("case.viewPhoto")}
          </button>
          {photo.status === "expired" && (
            <p className="muted dash-small" role="status">
              {t("case.photoRemoved")}
            </p>
          )}
        </div>
      )}
      {photo.status === "error" && <ErrorText error={photo.error} context="photo" />}
      {photo.status === "open" && (
        <PhotoViewer
          key={photo.photo.url}
          photo={photo.photo}
          alt={t("case.photoAlt", { kind })}
          onExpire={() => setPhoto({ status: "expired" })}
          onClose={() => setPhoto({ status: "closed" })}
        />
      )}
    </article>
  );
}
