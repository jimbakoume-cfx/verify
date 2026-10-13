import { createClient, type SupabaseClient, type SupabaseClientOptions } from "@supabase/supabase-js";

let client: SupabaseClient | null | undefined;

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
export const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/**
 * Browser Supabase client. Only the public "publishable" key is ever used here;
 * the service-role / secret key must never reach a web page.
 * The first call fixes the options (each app calls `configureSupabase` once at start-up).
 * Returns null when the app was built without Supabase settings.
 */
export function getSupabase(): SupabaseClient | null {
  if (client === undefined) configureSupabase();
  return client ?? null;
}

/** Create the client with app-specific auth options. Call once, before the first getSupabase(). */
export function configureSupabase(options?: SupabaseClientOptions<"public">): SupabaseClient | null {
  client = SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, options) : null;
  return client;
}

/** Base URL of a deployed Edge Function, e.g. functionUrl("flow"). Null when not configured. */
export function functionUrl(name: string): string | null {
  return SUPABASE_URL ? `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/${name}` : null;
}

export type ServerState = "checking" | "ok" | "not-configured" | "unreachable";

/** Calls the public `health()` database function to prove the app can reach the backend. */
export async function checkServer(): Promise<ServerState> {
  const supabase = getSupabase();
  if (!supabase) return "not-configured";
  try {
    const { data, error } = await supabase.rpc("health");
    return !error && data === "ok" ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
}
