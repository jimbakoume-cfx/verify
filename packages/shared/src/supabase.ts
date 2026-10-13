import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null | undefined;

/**
 * Browser Supabase client. Only the public "publishable" key is ever used here;
 * the service-role key must never reach a web page.
 * Returns null when the app was built without Supabase settings.
 */
export function getSupabase(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
  client = url && key ? createClient(url, key) : null;
  return client;
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
