// Deno glue: environment access and the service-role Supabase client. Everything testable lives in
// config.ts; this file is only imported by the functions' index.ts files.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { configProblems, type FunctionConfig, readConfig, resolveServiceKey, withDefaults } from "./config.ts";
import { TEST_ENVIRONMENT_DEFAULTS } from "./environment.ts";

export function env(name: string): string | undefined {
  return Deno.env.get(name) ?? undefined;
}

export function loadConfig(options: { needsRiderAppUrl?: boolean } = {}): FunctionConfig {
  const config = readConfig(withDefaults(env, TEST_ENVIRONMENT_DEFAULTS));
  for (const problem of configProblems(config, options)) {
    console.warn(JSON.stringify({ level: "warn", event: "config", problem }));
  }
  return config;
}

/**
 * Service-role client: bypasses RLS, so it never leaves the server. No session is kept, so one client
 * can serve every request (staff tokens are only passed to auth.getUser, never stored on the client).
 */
export function createServiceClient(): SupabaseClient {
  const url = env("SUPABASE_URL");
  const key = resolveServiceKey(env);
  if (!url || !key) throw new Error("SUPABASE_URL or the service key is not configured");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
