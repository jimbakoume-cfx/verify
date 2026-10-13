// A captured ID photo is shown from memory, never from the browser's HTTP cache. Storage serves
// uploaded objects with Cache-Control: max-age=3600 (storage-js's default on upload, and its
// header can only ever say max-age), so an <img src={signedUrl}> would leave a copy of the ID on
// the staff PC's disk for an hour after the 60-second link expired. Fetching with no-store and
// showing a blob: URL keeps the image in this tab's memory only, until close() frees it.

export interface PhotoSourceDeps {
  fetch: typeof fetch;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface PhotoSource {
  /** Resolves with a blob: URL for the image; rejects when it cannot be loaded or was closed. */
  ready: Promise<string>;
  /** Cancels the download and frees the image (link expired, photo hidden, page left, sign-out). */
  close(): void;
}

const browserDeps = (): PhotoSourceDeps => ({
  fetch: (input, init) => globalThis.fetch(input, init),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
});

/** Starts loading the signed image at `url`. */
export function openPhotoSource(url: string, deps: PhotoSourceDeps = browserDeps()): PhotoSource {
  // The dev preview's inline specimen holds no signed link and never touches the HTTP cache.
  if (/^(data|blob):/i.test(url)) return { ready: Promise.resolve(url), close: () => {} };
  const controller = new AbortController();
  let objectUrl: string | null = null;
  let closed = false;
  const ready = deps
    // A plain GET without custom headers: no CORS preflight (Storage answers with ACAO *).
    .fetch(url, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal })
    .then(async (res) => {
      if (!res.ok) throw new Error(`photo request failed: HTTP ${res.status}`);
      const blob = await res.blob();
      if (closed) throw new DOMException("The photo was closed.", "AbortError");
      objectUrl = deps.createObjectURL(blob);
      return objectUrl;
    });
  return {
    ready,
    close() {
      closed = true;
      controller.abort();
      if (objectUrl) deps.revokeObjectURL(objectUrl);
      objectUrl = null;
    },
  };
}
