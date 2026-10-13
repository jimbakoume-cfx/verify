// Supabase glue shared by the repos. Errors are rethrown as InternalError carrying only a context and
// the error code/status: PostgREST details can contain row values, so they are never kept.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditEntry } from "./audit.ts";
import { InternalError } from "./log.ts";

export function dbError(context: string, error: { code?: unknown; status?: unknown }): InternalError {
  return new InternalError(context, { code: error.code, status: error.status });
}

export async function insertAudit(db: SupabaseClient, entry: AuditEntry): Promise<void> {
  const { error } = await db.from("audit_event").insert({
    actor_type: entry.actorType,
    actor_id: entry.actorId,
    action: entry.action,
    target_type: entry.targetType,
    target_id: entry.targetId,
    details: entry.details ?? {},
  });
  if (error) throw dbError("audit_event.insert", error);
}
