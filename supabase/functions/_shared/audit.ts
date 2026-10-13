// Shape of an audit_event row as the functions write it. The hash chain is filled in by the database.

export interface AuditEntry {
  actorType: "system" | "staff" | "api_client" | "rider";
  /** Staff user id, api_client id, or the verification id for riders. */
  actorId: string;
  /** e.g. "capture.view". */
  action: string;
  targetType: string;
  targetId: string;
  /** Never tokens, codes, emails, document data or image bytes. */
  details?: Record<string, unknown>;
}
