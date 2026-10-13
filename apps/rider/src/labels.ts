import type { CaptureSide, DeclaredDocument } from "@verify/shared";

/** i18n key naming the side being photographed ("Front", or "Photo page" for a passport). */
export function sideLabelKey(document: DeclaredDocument | null, side: CaptureSide): string {
  return document === "passport" && side === "document_front" ? "sides.passportPage" : `sides.${side}`;
}
