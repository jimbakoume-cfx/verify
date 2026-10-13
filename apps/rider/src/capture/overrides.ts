// Debug mode only: lets the PM tune quality thresholds on a real phone from the URL, without a
// redeploy, e.g. /?debug=1&minSharpness=120&maxMotion=9#s=<token>.
import type { QualityThresholds } from "@verify/capture";

/** Threshold overrides found in `search`; unknown names and invalid numbers are ignored. */
export function parseThresholdOverrides(
  search: string,
  defaults: Readonly<QualityThresholds>,
): Partial<QualityThresholds> {
  const params = new URLSearchParams(search);
  const overrides: Partial<QualityThresholds> = {};
  for (const key of Object.keys(defaults) as (keyof QualityThresholds)[]) {
    const raw = params.get(key);
    if (raw === null || raw.trim() === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) continue;
    if (key === "stableFramesRequired" && !(Number.isInteger(value) && value >= 1)) continue;
    overrides[key] = value;
  }
  return overrides;
}
