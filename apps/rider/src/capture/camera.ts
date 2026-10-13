// Opening and closing the back camera, and turning its failures into something the rider can act on.

export const CAMERA_ERROR_KINDS = ["denied", "no_camera", "insecure", "busy", "unsupported", "unknown"] as const;
export type CameraErrorKind = (typeof CAMERA_ERROR_KINDS)[number];

export class CameraError extends Error {
  constructor(readonly kind: CameraErrorKind) {
    super(kind);
    this.name = "CameraError";
  }
}

/** Spec constraints: back camera, Full HD if available (phones then deliver portrait 1080x1920). */
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  audio: false,
};

interface CameraEnvironment {
  isSecureContext: boolean;
  mediaDevices?: { getUserMedia?: unknown } | undefined;
}

/** Why the camera cannot even be requested here, or null when it can. */
export function cameraSupport(env: CameraEnvironment): CameraErrorKind | null {
  // Browsers hide navigator.mediaDevices entirely on http:// pages.
  if (!env.isSecureContext) return "insecure";
  if (typeof env.mediaDevices?.getUserMedia !== "function") return "unsupported";
  return null;
}

/** Maps a getUserMedia rejection (a DOMException name) to a rider-facing kind. */
export function classifyCameraError(err: unknown, isSecureContext = true): CameraErrorKind {
  if (err instanceof CameraError) return err.kind;
  const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "denied";
    case "SecurityError":
      return isSecureContext ? "denied" : "insecure";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "no_camera";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "busy";
    default:
      return "unknown";
  }
}

/** Asks for the back camera. Throws CameraError. */
export async function openCamera(nav: Navigator = navigator, secure: boolean = window.isSecureContext): Promise<MediaStream> {
  const unsupported = cameraSupport({ isSecureContext: secure, mediaDevices: nav.mediaDevices });
  if (unsupported) throw new CameraError(unsupported);
  try {
    return await nav.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
  } catch (err) {
    // `ideal` constraints should never over-constrain, but some old WebViews disagree: try once
    // more with any camera before giving up.
    if (classifyCameraError(err, secure) === "no_camera" && (err as { name?: string }).name === "OverconstrainedError") {
      try {
        return await nav.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (retryErr) {
        throw new CameraError(classifyCameraError(retryErr, secure));
      }
    }
    throw new CameraError(classifyCameraError(err, secure));
  }
}

/** Stops every track: the camera light goes off and the phone releases the sensor. */
export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}
