import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openPhotoSource } from "../lib/photo";
import { Countdown } from "./Countdown";

export interface OpenPhoto {
  /** Signed link from POST /admin/captures/view. Held in React state only: never in Web Storage. */
  url: string;
  /** When the link stops working (client clock). */
  deadlineMs: number;
}

/**
 * Shows a signed capture image and removes it when the link expires. The image is fetched past the
 * HTTP cache and shown from memory (lib/photo.ts), freed when the link expires, the photo is hidden
 * or the page goes away (sign-out included). The referrer is withheld so the signed URL never
 * travels further than the storage server.
 */
export function PhotoViewer({
  photo,
  alt,
  onExpire,
  onClose,
}: {
  photo: OpenPhoto;
  alt: string;
  onExpire: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const [src, setSrc] = useState<string | null>(null);

  // The parent remounts this viewer for each new link (key), so this runs once per link; the
  // cleanup frees the image (and runs twice in development under StrictMode, harmlessly).
  useEffect(() => {
    let active = true;
    const source = openPhotoSource(photo.url);
    source.ready.then(
      (url) => active && setSrc(url),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
      source.close();
      setSrc(null);
    };
  }, [photo.url]);
  // Only a new link restarts the timer, not a re-render with a fresh onExpire closure.
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    const id = window.setTimeout(() => onExpireRef.current(), Math.max(0, photo.deadlineMs - Date.now()));
    return () => window.clearTimeout(id);
  }, [photo.url, photo.deadlineMs]);

  return (
    <figure className="dash-photo">
      {failed ? (
        <p className="dash-alert error" role="alert">
          {t("case.photoLoadFailed")}
        </p>
      ) : src ? (
        <img src={src} alt={alt} decoding="async" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <p className="muted" role="status">
          {t("case.photoLoading")}
        </p>
      )}
      <figcaption>
        <Countdown deadlineMs={photo.deadlineMs} runningKey="case.photoExpiresIn" expiredKey="case.photoExpired" />
        <button type="button" className="small" onClick={onClose}>
          {t("case.hidePhoto")}
        </button>
      </figcaption>
    </figure>
  );
}
