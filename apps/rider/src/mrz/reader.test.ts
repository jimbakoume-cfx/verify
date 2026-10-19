import { type GrayImage, decodePgm } from "@verify/capture";
import { type MrzExpectation, MRZ_EXPECTATION } from "@verify/shared";
import { describe, expect, it, vi } from "vitest";
import { OcrError, type OcrEngine } from "./ocrEngine";
import { createMrzReader } from "./reader";
import { MRZ_MODELS } from "./types";

const TD3 = ["P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<", "L898902C36UTO7408122F1204159ZE184226B<<<<<10"];
const at = (line: string, i: number, c: string) => line.slice(0, i) + c + line.slice(i + 1);
const passport = MRZ_EXPECTATION.passport as MrzExpectation;
const card = MRZ_EXPECTATION.cni_biometric as MrzExpectation;

/** A blank still: the band locator falls back to its bottom crop, which is all these tests need. */
const still: GrayImage = { width: 816, height: 575, data: new Uint8Array(816 * 575).fill(200) };

/** An engine that answers each OCR pass with the next text (or error) from `answers`. */
function fakeEngine(answers: (string | Error)[], ready: () => Promise<void> = async () => {}) {
  const images: Uint8Array[] = [];
  const engine: OcrEngine & { recognize: ReturnType<typeof vi.fn> } = {
    warmUp: vi.fn(),
    ready: vi.fn(ready),
    recognize: vi.fn(async (bytes: Uint8Array) => {
      images.push(bytes);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected OCR pass");
      if (answer instanceof Error) throw answer;
      return answer;
    }),
    dispose: vi.fn(),
  };
  return { engine, images };
}

/** A clock that advances 100 ms per reading. */
function clock() {
  let t = 1000;
  return () => (t += 100);
}

describe("createMrzReader", () => {
  it("reads valid lines in one pass and reports what the debug panel shows", async () => {
    const { engine, images } = fakeEngine([`noise\n${TD3.join("\n")}\n`]);
    const reader = createMrzReader({ engine, now: clock(), today: () => new Date("2026-10-14") });
    const result = await reader.read(still, passport);
    expect(result).toMatchObject({
      status: "valid",
      format: "TD3",
      lines: TD3,
      corrections: 0,
      ms: 100,
      rawText: `noise\n${TD3.join("\n")}\n`,
      // The blank still has no lines to measure: the fallback crop gives no character height.
      charHeight: null,
      rotated: false,
    });
    expect(result.parsed).toMatchObject({ documentNumber: "L898902C3", surname: "ERIKSSON", valid: true });
    expect(engine.recognize).toHaveBeenCalledTimes(1);
    // The engine gets a PGM of the prepared band.
    const header = new TextDecoder().decode(images[0].subarray(0, 2));
    expect(header).toBe("P5");
    const decoded = decodePgm(images[0]);
    expect(decoded.width).toBeGreaterThan(100);
  });

  it("passes the cancel signal and the start-up progress to the engine", async () => {
    const { engine } = fakeEngine([TD3.join("\n")]);
    const reader = createMrzReader({ engine });
    const signal = new AbortController().signal;
    const onProgress = vi.fn();
    await reader.read(still, passport, { signal, onProgress });
    expect(engine.ready).toHaveBeenCalledWith({ signal, onProgress });
    expect(engine.recognize).toHaveBeenCalledWith(expect.any(Uint8Array), { signal });
  });

  it("is unavailable when the engine cannot start, without trying to read", async () => {
    const { engine } = fakeEngine([], async () => {
      throw new OcrError("load_failed");
    });
    const result = await createMrzReader({ engine }).read(still, card);
    expect(result).toEqual({
      status: "unavailable",
      format: "TD1",
      lines: null,
      parsed: null,
      corrections: 0,
      ms: 0,
      rawText: "",
      charHeight: null,
      rotated: false,
      // The default model (real sessions) read, or rather could not.
      engine: "tesseract.js-7.0.0/mrz-1",
    });
    expect(engine.recognize).not.toHaveBeenCalled();
  });

  it("names the model it reads with (M4: our own for test sessions)", async () => {
    const { engine } = fakeEngine([TD3.join("\n")]);
    const result = await createMrzReader({ engine, model: MRZ_MODELS["mrz-2"] }).read(still, passport);
    expect(result).toMatchObject({ status: "valid", engine: "tesseract.js-7.0.0/mrz-2" });
  });

  it("tries the still turned 180 degrees when nothing was found", async () => {
    const { engine } = fakeEngine(["SPECIMEN", TD3.join("\n")]);
    const result = await createMrzReader({ engine }).read(still, passport);
    expect(result).toMatchObject({ status: "valid", rotated: true, lines: TD3 });
    expect(engine.recognize).toHaveBeenCalledTimes(2);
  });

  it("tries the other threshold when the lines fail their check digits", async () => {
    const wrong = [TD3[0], at(TD3[1], 15, "9")];
    const { engine } = fakeEngine([wrong.join("\n"), TD3.join("\n")]);
    const result = await createMrzReader({ engine }).read(still, passport);
    expect(result).toMatchObject({ status: "valid", lines: TD3, rotated: false });
    expect(engine.recognize).toHaveBeenCalledTimes(2);
  });

  it("repairs the document number from the other pass's reading, and counts it", async () => {
    // Pass 1 read O for 0 in the number; pass 2 read that 0 right but misread the personal number.
    const first = [TD3[0], at(TD3[1], 5, "O")];
    const second = [TD3[0], at(TD3[1], 34, "Z")];
    const { engine } = fakeEngine([first.join("\n"), second.join("\n")]);
    const result = await createMrzReader({ engine }).read(still, passport);
    expect(result).toMatchObject({ status: "valid", lines: TD3, corrections: 1 });
  });

  it("returns invalid lines when no pass reads them right", async () => {
    const wrong = [TD3[0], at(TD3[1], 15, "9")];
    const { engine } = fakeEngine([wrong.join("\n"), wrong.join("\n")]);
    const result = await createMrzReader({ engine }).read(still, passport);
    expect(result.status).toBe("invalid");
    expect(result.lines).toEqual(wrong);
    expect(result.parsed?.checks).toMatchObject({ birthDate: false, documentNumber: true });
  });

  it("reports not_found after the three passes find nothing", async () => {
    const { engine } = fakeEngine(["", "<<<", "IIII"]);
    const result = await createMrzReader({ engine }).read(still, card);
    expect(result).toMatchObject({ status: "not_found", lines: null, parsed: null, corrections: 0 });
    expect(engine.recognize).toHaveBeenCalledTimes(3);
  });

  it("is unavailable when the read is cancelled, even after a first pass", async () => {
    const controller = new AbortController();
    const { engine } = fakeEngine(["", new OcrError("aborted")]);
    engine.recognize.mockImplementationOnce(async () => {
      controller.abort();
      return "";
    });
    const result = await createMrzReader({ engine }).read(still, card, { signal: controller.signal });
    expect(result.status).toBe("unavailable");
  });

  it("keeps the first pass's result when a later pass times out", async () => {
    const wrong = [TD3[0], at(TD3[1], 15, "9")];
    const { engine } = fakeEngine([wrong.join("\n"), new OcrError("read_timeout")]);
    const result = await createMrzReader({ engine }).read(still, passport);
    expect(result).toMatchObject({ status: "invalid", lines: wrong });
  });

  it("is unavailable when the first pass fails", async () => {
    const { engine } = fakeEngine([new OcrError("read_failed")]);
    expect((await createMrzReader({ engine }).read(still, passport)).status).toBe("unavailable");
  });

  it("only accepts lines of the expected format", async () => {
    const { engine } = fakeEngine([TD3.join("\n"), TD3.join("\n"), TD3.join("\n")]);
    expect((await createMrzReader({ engine }).read(still, card)).status).toBe("not_found");
  });

  it("hands warmUp and dispose to the engine", () => {
    const { engine } = fakeEngine([]);
    const reader = createMrzReader({ engine });
    reader.warmUp();
    reader.dispose();
    expect(engine.warmUp).toHaveBeenCalledTimes(1);
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });
});
