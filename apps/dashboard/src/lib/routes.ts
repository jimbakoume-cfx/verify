// Paths of the dashboard. Everything else falls back to the home page.
const CASE_PATH = /^\/case\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

export type Route = { name: "home" } | { name: "case"; id: string };

export function parseRoute(pathname: string): Route {
  const match = CASE_PATH.exec(pathname);
  return match ? { name: "case", id: match[1].toLowerCase() } : { name: "home" };
}

export function casePath(id: string): string {
  return `/case/${encodeURIComponent(id)}`;
}
