// "Data read from the document" section of the case page: "Show data read" reveals the code lines read
// on the phone and by the server, and the printed text read by the server (audited before anything is
// decrypted, shown for a limited time, kept in memory only).
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useServices } from "../api/services";
import { DocumentDataViewer, type OpenDocumentData } from "../components/DocumentDataViewer";
import { ErrorText } from "../components/Feedback";
import type { CaptureRecord, StaffProfile } from "../lib/records";
import { documentDataAccess } from "../lib/roles";

type DataState =
  | { status: "closed" }
  | { status: "opening" }
  | { status: "open"; data: OpenDocumentData }
  | { status: "expired" }
  | { status: "error"; error: unknown };

export function DocumentDataSection({
  verificationId,
  captures,
  mayHaveData,
  profile,
  initialData,
}: {
  verificationId: string;
  captures: CaptureRecord[];
  /** Something may have been stored: the phone read lines, or the server processed a photo. */
  mayHaveData: boolean;
  profile: StaffProfile;
  /** Data already shown (dev screen preview only). */
  initialData?: OpenDocumentData;
}) {
  const { t } = useTranslation();
  const services = useServices();
  const [data, setData] = useState<DataState>(initialData ? { status: "open", data: initialData } : { status: "closed" });
  // Stable while the captures are the same, so the viewer does not re-sort the data on every render.
  const kindOf = useCallback(
    (captureId: string) => captures.find((c) => c.id === captureId)?.kind ?? null,
    [captures],
  );

  async function show() {
    setData({ status: "opening" });
    // Count the time from before the request: the server's clock started no earlier than this.
    const requestedAt = Date.now();
    try {
      const response = await services.documentData(verificationId);
      setData({ status: "open", data: { items: response.items, deadlineMs: requestedAt + response.expiresIn * 1000 } });
    } catch (err) {
      setData({ status: "error", error: err });
    }
  }

  // Kept while data is open, so its timer always runs: data never sits in memory unshown.
  if (!mayHaveData && data.status !== "open") return null;

  return (
    <section className="card" aria-labelledby="data-title">
      <h2 id="data-title">{t("data.title")}</h2>
      <p className="muted">{t("data.intro")}</p>
      <div className="dash-mrz-access">
        {documentDataAccess(profile.role) === "admin_blocked" ? (
          <p className="dash-alert info">{t("errors.adminNoDataAccess")}</p>
        ) : (
          <>
            {data.status !== "open" && (
              <>
                <p className="muted dash-small">{t("data.logged")}</p>
                <div className="dash-capture-actions">
                  <button type="button" onClick={() => void show()} disabled={data.status === "opening"}>
                    {data.status === "opening" ? t("case.opening") : t("data.show")}
                  </button>
                  {data.status === "expired" && (
                    <p className="muted dash-small" role="status">
                      {t("data.removed")}
                    </p>
                  )}
                </div>
              </>
            )}
            {data.status === "error" && <ErrorText error={data.error} context="documentData" />}
            {data.status === "open" && (
              <DocumentDataViewer
                key={data.data.deadlineMs}
                data={data.data}
                kindOf={kindOf}
                onExpire={() => setData({ status: "expired" })}
                onClose={() => setData({ status: "closed" })}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}
