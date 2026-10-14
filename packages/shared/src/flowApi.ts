// The HTTP contract lives next to the Edge Functions (Deno needs it there);
// this re-export makes it available to the web apps from one source of truth.
export * from "../../../supabase/functions/_shared/contract";
export * from "../../../supabase/functions/_shared/staffPassword";
export * from "../../../supabase/functions/_shared/mrz";
