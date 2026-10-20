// GET /flow/result (automatic approval, PM 2026-10-20): what the rider is told after the submit. Pure:
// the database decides (public.flow_result); this keeps only the three states and an https return
// address, so nothing else can ever reach the rider.
import { FLOW_RESULT_STATES, type FlowResult } from "../_shared/contract.ts";

/** Longest return address accepted (the database refuses longer ones too). */
export const RETURN_URL_MAX_LENGTH = 2048;

/** An https address without spaces, as verification.return_url allows; null otherwise. */
export function safeReturnUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > RETURN_URL_MAX_LENGTH || !/^https:\/\/\S+$/.test(value)) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * flow_result's answer as the rider may see it: an unknown state counts as review (a person checks the
 * case), and the return address goes with "verified" only.
 */
export function toFlowResult(value: unknown): FlowResult {
  const row = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const state = (FLOW_RESULT_STATES as readonly unknown[]).includes(row.state) ? (row.state as FlowResult["state"]) : "review";
  return { state, returnUrl: state === "verified" ? safeReturnUrl(row.returnUrl) : null };
}
