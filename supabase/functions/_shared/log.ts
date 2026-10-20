// Server-side error logging. Library error messages can echo request values (an email, a path, a
// JSON fragment), so only structural fields are logged: never messages from outside this codebase.

export interface Logger {
  error(event: string, err?: unknown): void;
  /** A measurement (timings, counts): generic numbers, codes and booleans only, never a value read. */
  info?(event: string, fields: Record<string, number | string | boolean>): void;
}

/** An error raised by our own glue code; its message is written by us and is safe to log. */
export class InternalError extends Error {
  readonly code?: string;
  readonly status?: number;

  constructor(context: string, detail: { code?: unknown; status?: unknown } = {}) {
    super(context);
    this.name = "InternalError";
    if (typeof detail.code === "string") this.code = detail.code.slice(0, 64);
    if (typeof detail.status === "number") this.status = detail.status;
  }
}

export interface ErrorSummary {
  name?: string;
  context?: string;
  code?: string;
  status?: number;
  /** Stack frames only (file:line), without the message line. */
  at?: string;
}

export function summarizeError(err: unknown): ErrorSummary {
  if (!(err instanceof Error)) return { name: typeof err };
  const summary: ErrorSummary = { name: err.name };
  if (err instanceof InternalError) {
    summary.context = err.message;
    if (err.code) summary.code = err.code;
    if (err.status !== undefined) summary.status = err.status;
  }
  // V8 stacks start with "Name: message", which may span several lines: drop it, then keep frames only.
  let stack = err.stack ?? "";
  const header = String(err);
  if (stack.startsWith(header)) stack = stack.slice(header.length);
  else stack = "";
  const frames = stack.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("at "))
    .slice(0, 3).join(" | ");
  if (frames) summary.at = frames;
  return summary;
}

export const consoleLogger: Logger = {
  error(event, err) {
    console.error(JSON.stringify({ level: "error", event, ...(err === undefined ? {} : summarizeError(err)) }));
  },
  info(event, fields) {
    console.log(JSON.stringify({ level: "info", event, ...fields }));
  },
};
