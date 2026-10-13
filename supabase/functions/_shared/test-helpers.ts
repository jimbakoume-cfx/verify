// Helpers for the vitest suites (never imported by a function entry point, so never deployed).

export interface JpegOptions {
  width: number;
  height: number;
  /** Frame marker: 0xc0 baseline, 0xc2 progressive. */
  sof?: number;
  /** Total size to reach with a comment segment placed before the frame header. */
  padTo?: number;
  components?: number;
}

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
// APP0 "JFIF\0", version 1.01, no units, 1x1 density, no thumbnail.
const APP0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];

export function sofSegment(width: number, height: number, sof = 0xc0, components = 3): number[] {
  const length = 8 + 3 * components;
  const out = [0xff, sof, length >> 8, length & 0xff, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, components];
  for (let c = 1; c <= components; c++) out.push(c, 0x11, 0);
  return out;
}

/** COM segment(s) carrying `size` bytes in total (headers included); each segment holds at most 65535. */
export function commentSegments(size: number): number[] {
  const out: number[] = [];
  let remaining = size;
  while (remaining >= 4) {
    const segment = Math.min(remaining, 65537);
    const length = segment - 2;
    out.push(0xff, 0xfe, length >> 8, length & 0xff);
    for (let i = 0; i < length - 2; i++) out.push(0x20);
    remaining -= segment;
  }
  return out;
}

/** SOI + APP0 + optional padding + SOF + EOI: enough for the server's checks, not a decodable image. */
export function buildJpeg({ width, height, sof = 0xc0, padTo = 0, components = 3 }: JpegOptions): Uint8Array<ArrayBuffer> {
  const head = [...SOI, ...APP0];
  const frame = sofSegment(width, height, sof, components);
  const fixed = head.length + frame.length + EOI.length;
  const padding = padTo > fixed ? commentSegments(padTo - fixed) : [];
  return Uint8Array.from([...head, ...padding, ...frame, ...EOI]);
}

export function bytes(...values: number[]): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(values);
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  /** null: no Origin header. */
  origin?: string | null;
}

export function makeRequest(url: string, { method = "POST", body, rawBody, headers = {}, origin }: CallOptions = {}) {
  const h = new Headers(headers);
  if (origin !== null) h.set("origin", origin ?? "https://app.example");
  let payload: string | undefined = rawBody;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    h.set("content-type", "application/json");
  }
  return new Request(url, { method, headers: h, body: payload });
}

export async function readJson(res: Response): Promise<Record<string, unknown>> {
  return await res.json() as Record<string, unknown>;
}

export const ALLOWED_ORIGIN = "https://app.example";
