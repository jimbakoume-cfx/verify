// supabase-js sends a Blob to uploadToSignedUrl as multipart/form-data (a "cacheControl" field and
// the file). This extracts the file part as the storage API would see it.

export interface FilePart {
  contentType: string | null;
  bytes: Buffer;
}

const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

/** The first part that carries a file (a `filename`), or null when there is none. */
export function readFilePart(body: Buffer, contentTypeHeader: string | undefined): FilePart | null {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentTypeHeader ?? "");
  if (!boundary) return null;
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const partStart = start + delimiter.length + CRLF.length;
    const next = body.indexOf(delimiter, partStart);
    if (next === -1) break;
    const headerEnd = body.indexOf(HEADER_END, partStart);
    if (headerEnd !== -1 && headerEnd < next) {
      const headers = body.subarray(partStart, headerEnd).toString("latin1");
      if (/filename=/i.test(headers)) {
        const type = /^content-type:\s*(.+)$/im.exec(headers);
        // The part's data ends with the CRLF that precedes the next delimiter.
        return { contentType: type ? type[1].trim() : null, bytes: body.subarray(headerEnd + HEADER_END.length, next - CRLF.length) };
      }
    }
    start = next;
  }
  return null;
}
