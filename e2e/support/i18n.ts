// The rider app's own FR/EN strings, so the tests find screens the way a rider reads them.
import en from "../../apps/rider/src/locales/en.json";
import fr from "../../apps/rider/src/locales/fr.json";

export type Language = "fr" | "en";

const RESOURCES: Record<Language, unknown> = { fr, en };

/** The text of `key` (e.g. "review.title") in `lang`, with {{name}} placeholders filled in. */
export function translate(lang: Language, key: string, vars: Record<string, string | number> = {}): string {
  let node: unknown = RESOURCES[lang];
  for (const part of key.split(".")) node = (node as Record<string, unknown> | undefined)?.[part];
  if (typeof node !== "string") throw new Error(`no ${lang} text for "${key}"`);
  return node.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? `{{${name}}}`));
}
