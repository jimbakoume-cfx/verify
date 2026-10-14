import type { CaptureSide, DeclaredDocument } from "@verify/shared";

/** i18n key naming the side being photographed ("Front", or "Photo page" for a passport). */
export function sideLabelKey(document: DeclaredDocument | null, side: CaptureSide): string {
  return document === "passport" && side === "document_front" ? "sides.passportPage" : `sides.${side}`;
}

/**
 * i18n key of a hint that tells the two CNI models apart on the document list: only the new card
 * (2025) has code lines (3 lines of <<< on the back). Null for the other documents.
 */
export function documentHintKey(document: DeclaredDocument): string | null {
  switch (document) {
    case "cni_biometric":
      return "document.cniBiometricHint";
    case "cni_legacy":
      return "document.cniLegacyHint";
    default:
      return null;
  }
}
