// Paths of the dashboard. Everything else falls back to the home page.
const CASE_PATH = /^\/case\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

const THRESHOLDS_PATH = /^\/thresholds\/?$/;

export type Route = { name: "home" } | { name: "case"; id: string } | { name: "thresholds" };

export function parseRoute(pathname: string): Route {
  const match = CASE_PATH.exec(pathname);
  if (match) return { name: "case", id: match[1].toLowerCase() };
  return THRESHOLDS_PATH.test(pathname) ? { name: "thresholds" } : { name: "home" };
}

/** M8: the admins' thresholds page. */
export const thresholdsPath = "/thresholds";

export function casePath(id: string): string {
  return `/case/${encodeURIComponent(id)}`;
}
