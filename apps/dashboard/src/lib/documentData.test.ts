import { describe, expect, it } from "vitest";
import type { DocumentDataItem, DocumentDataLinesItem } from "@verify/shared";
import { counterpartLines, lineDifferences, orderDataItems, printedFields } from "./documentData";

// ICAO 9303 specimens (Utopia): no real person.
const TD1 = ["I<UTOD231458907<<<<<<<<<<<<<<<", "7408122F1204159UTO<<<<<<<<<<<6", "ERIKSSON<<ANNA<MARIA<<<<<<<<<<"];

const lines = (captureId: string, source: DocumentDataLinesItem["source"], recordedAt = "2026-10-14T09:00:00Z") =>
  ({ captureId, source, format: "TD1", lines: TD1, recordedAt }) as const;
const printed = (captureId: string, recordedAt = "2026-10-14T09:00:00Z"): DocumentDataItem => ({
  captureId,
  source: "ocr_server",
  fields: { surname: "ERIKSSON" },
  recordedAt,
});

describe("orderDataItems", () => {
  const kinds: Record<string, string> = { front: "document_front", back: "document_back" };
  const kindOf = (id: string) => kinds[id] ?? null;
  const keys = (items: DocumentDataItem[]) => items.map((i) => `${i.captureId}.${i.source}`);

  it("groups by side, front first, then phone lines, server lines and printed text", () => {
    const items: DocumentDataItem[] = [
      printed("back"),
      lines("back", "mrz_server"),
      printed("front"),
      lines("gone", "mrz_phone"),
      lines("back", "mrz_phone"),
    ];
    expect(keys(orderDataItems(items, kindOf))).toEqual([
      "front.ocr_server",
      "back.mrz_phone",
      "back.mrz_server",
      "back.ocr_server",
      "gone.mrz_phone",
    ]);
  });

  it("does not change the list it was given", () => {
    const items: DocumentDataItem[] = [printed("back"), printed("front")];
    orderDataItems(items, kindOf);
    expect(keys(items)).toEqual(["back.ocr_server", "front.ocr_server"]);
  });
});

describe("counterpartLines", () => {
  it("finds the other reading of the same photo's lines", () => {
    const phone = lines("back", "mrz_phone");
    const server = lines("back", "mrz_server");
    const items: DocumentDataItem[] = [phone, server, printed("back"), lines("front", "mrz_server")];
    expect(counterpartLines(phone, items)).toBe(server);
    expect(counterpartLines(server, items)).toBe(phone);
    expect(counterpartLines(lines("front", "mrz_server"), items)).toBeNull();
  });
});

describe("lineDifferences", () => {
  it("marks each character that differs from the other reading, and missing ones", () => {
    expect(lineDifferences(["AB<C", "12"], ["AB<D", "1"])).toEqual([
      [false, false, false, true],
      [false, true],
    ]);
    expect(lineDifferences(["AB"], [])).toEqual([[true, true]]);
  });

  it("marks nothing without another reading, or when both are the same", () => {
    expect(lineDifferences(TD1, null).flat().some(Boolean)).toBe(false);
    expect(lineDifferences(TD1, TD1).flat().some(Boolean)).toBe(false);
  });
});

describe("printedFields", () => {
  it("lists the fields read in page order, leaving out those not read", () => {
    expect(
      printedFields({ issueDate: "2025-03-01", subtype: "refugee", surname: "ERIKSSON", givenNames: "ANNA MARIA" }),
    ).toEqual([
      { key: "surname", value: { type: "text", text: "ERIKSSON" } },
      { key: "givenNames", value: { type: "text", text: "ANNA MARIA" } },
      { key: "issueDate", value: { type: "date", iso: "2025-03-01" } },
      { key: "subtype", value: { type: "subtype", subtype: "refugee", raw: "refugee" } },
    ]);
    expect(printedFields({})).toEqual([]);
  });

  it("shows a date the worker could not complete as printed", () => {
    const fields = Object.fromEntries(
      printedFields({ birthDate: "1974-08-12", expiryDate: "08/2031", issueDate: "2025-02-30" }).map((f) => [f.key, f.value]),
    );
    expect(fields).toEqual({
      birthDate: { type: "date", iso: "1974-08-12" },
      expiryDate: { type: "partialDate", raw: "08/2031" },
      issueDate: { type: "partialDate", raw: "2025-02-30" },
    });
  });

  it("names the card sub-types it knows and shows any other as read", () => {
    const subtype = (raw: string) => printedFields({ subtype: raw })[0].value;
    expect(subtype("carte_de_sejour")).toEqual({ type: "subtype", subtype: "carte_de_sejour", raw: "carte_de_sejour" });
    expect(subtype("carte_de_resident")).toEqual({ type: "subtype", subtype: "carte_de_resident", raw: "carte_de_resident" });
    expect(subtype("diplomatic")).toEqual({ type: "subtype", subtype: null, raw: "diplomatic" });
  });

  it("keeps a document number as text, even when it looks like a date", () => {
    expect(printedFields({ documentNumber: "2025-03-01" })).toEqual([
      { key: "documentNumber", value: { type: "text", text: "2025-03-01" } },
    ]);
  });
});
