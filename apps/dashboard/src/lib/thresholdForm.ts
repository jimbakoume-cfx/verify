// M8: the admin's threshold form. Numbers are typed as text (a French "0,5" too), turned into a
// configuration, and checked with the same rules as the server (thresholdConfigErrors in risk.ts).
import {
  type ConfigChange,
  DECLARED_DOCUMENTS,
  type DeclaredDocument,
  diffThresholdConfig,
  normaliseThresholdConfig,
  RISK_SIGNALS,
  type RiskSignal,
  THRESHOLD_CONFIG_SCHEMA,
  THRESHOLD_NOTE_MAX_LENGTH,
  THRESHOLD_NOTE_MIN_LENGTH,
  type ThresholdConfig,
  thresholdConfigErrors,
} from "@verify/shared";

export interface ThresholdForm {
  weights: Record<RiskSignal, string>;
  enabled: Record<RiskSignal, boolean>;
  hardFlags: RiskSignal[];
  approveMax: string;
  rejectMin: string;
  alwaysReviewDocuments: DeclaredDocument[];
  autoDecide: boolean;
  note: string;
}

/** Plain decimal text, a comma or a point; anything else is kept as text so the rules say not_number. */
export function parseScore(text: string): number | string {
  const normalised = text.trim().replace(",", ".");
  return /^\d+(\.\d+)?$/.test(normalised) || /^\.\d+$/.test(normalised) ? Number(normalised) : text;
}

export function formFromConfig(config: ThresholdConfig): ThresholdForm {
  const weights = {} as Record<RiskSignal, string>;
  const enabled = {} as Record<RiskSignal, boolean>;
  for (const code of RISK_SIGNALS) {
    weights[code] = String(config.signals[code].weight);
    enabled[code] = config.signals[code].enabled;
  }
  return {
    weights,
    enabled,
    hardFlags: [...config.hardFlags],
    approveMax: String(config.approveMax),
    rejectMin: String(config.rejectMin),
    alwaysReviewDocuments: [...config.alwaysReviewDocuments],
    autoDecide: config.autoDecide,
    note: "",
  };
}

/** The configuration the form describes (possibly invalid: check it with thresholdConfigErrors). */
export function configFromForm(form: ThresholdForm): Record<string, unknown> {
  const signals: Record<string, unknown> = {};
  for (const code of RISK_SIGNALS) signals[code] = { weight: parseScore(form.weights[code]), enabled: form.enabled[code] };
  return {
    schema: THRESHOLD_CONFIG_SCHEMA,
    signals,
    approveMax: parseScore(form.approveMax),
    rejectMin: parseScore(form.rejectMin),
    hardFlags: RISK_SIGNALS.filter((code) => form.hardFlags.includes(code)),
    alwaysReviewDocuments: DECLARED_DOCUMENTS.filter((doc) => form.alwaysReviewDocuments.includes(doc)),
    autoDecide: form.autoDecide,
  };
}

export type FormCheck =
  | { ok: true; config: ThresholdConfig; changes: ConfigChange[]; noteError: "missing" | "short" | "long" | null }
  | { ok: false; errors: string[]; noteError: "missing" | "short" | "long" | null };

function noteError(note: string): "missing" | "short" | "long" | null {
  const length = [...note.trim()].length;
  if (length === 0) return "missing";
  if (length < THRESHOLD_NOTE_MIN_LENGTH) return "short";
  if (length > THRESHOLD_NOTE_MAX_LENGTH) return "long";
  return null;
}

/** The form's configuration checked, and what it changes from the active version. */
export function checkForm(form: ThresholdForm, active: ThresholdConfig | null): FormCheck {
  const value = configFromForm(form);
  const errors = thresholdConfigErrors(value);
  if (errors.length > 0) return { ok: false, errors, noteError: noteError(form.note) };
  const config = normaliseThresholdConfig(value as unknown as ThresholdConfig);
  return { ok: true, config, changes: active ? diffThresholdConfig(active, config) : [], noteError: noteError(form.note) };
}

/** The errors about one field ("signals.date_logic.weight", "rejectMin"...), as their codes. */
export function errorsFor(errors: readonly string[], path: string): string[] {
  return errors.filter((e) => e.slice(0, e.lastIndexOf(":")) === path).map((e) => e.slice(e.lastIndexOf(":") + 1));
}
