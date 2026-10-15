import { describe, expect, it } from "vitest";
import { toWorkerFields } from "./repo.ts";

describe("toWorkerFields (printed fields read back from staff_read_document_data)", () => {
  it("keeps the known fields with string values", () => {
    expect(toWorkerFields({ surname: "DOE", issueDate: "2025-03-01", subtype: "carte_de_sejour" }))
      .toEqual({ surname: "DOE", issueDate: "2025-03-01", subtype: "carte_de_sejour" });
    expect(toWorkerFields({})).toEqual({});
  });

  it.each<unknown>([null, [], "DOE", { address: "Rue 1" }, { surname: 3 }, { toString: "y" }])(
    "refuses %j rather than show something unexpected",
    (value) => {
      expect(toWorkerFields(value)).toBeNull();
    },
  );
});
