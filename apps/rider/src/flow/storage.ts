// Upload of the JPEG straight to the private Supabase bucket with the signed token from
// POST /flow/upload-url. No image ever passes through our web host.
import { getSupabase } from "@verify/shared";
import { FlowError } from "./errors";
import type { PutObject } from "./upload";

/** The subset of supabase-js's StorageError we rely on. */
export interface StorageErrorLike {
  /** HTTP status of the storage response; undefined when the request never got an answer. */
  status?: number;
  /** Storage's own code, e.g. "409" for an object that already exists. */
  statusCode?: string;
  message?: string;
  /** What fetch threw, for a request that never got an answer (StorageUnknownError). */
  originalError?: { name?: string } | null;
}

/**
 * Classifies a storage upload error. "already_stored" means a previous attempt did upload the
 * object (its answer was lost): the token can only be used once, so this counts as a success.
 */
export function classifyStorageError(error: StorageErrorLike): "already_stored" | FlowError {
  if (error.statusCode === "409" || error.status === 409 || /already exists/i.test(error.message ?? "")) {
    return "already_stored";
  }
  if (error.status === undefined || error.status === 0) {
    // timeoutFetch (main.tsx) aborts a stalled upload: say so, rather than "no connection".
    return new FlowError(error.originalError?.name === "AbortError" ? "timeout" : "network");
  }
  if (error.status >= 500) return new FlowError("server_error", error.status);
  return new FlowError("storage_failed", error.status);
}

export const putObjectWithSupabase: PutObject = async (target, blob) => {
  const supabase = getSupabase();
  if (!supabase) throw new FlowError("not_configured");
  let error: StorageErrorLike | null;
  try {
    ({ error } = await supabase.storage
      .from(target.bucket)
      .uploadToSignedUrl(target.path, target.token, blob, { contentType: "image/jpeg" }));
  } catch {
    throw new FlowError("network");
  }
  if (!error) return;
  const result = classifyStorageError(error);
  if (result !== "already_stored") throw result;
};
