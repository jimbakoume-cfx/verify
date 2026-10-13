import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { qrRuns } from "./qr";

function redraw(size: number, runs: ReturnType<typeof qrRuns>): boolean[][] {
  const grid = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  for (const run of runs) for (let i = 0; i < run.length; i++) grid[run.y][run.x + i] = true;
  return grid;
}

describe("qrRuns", () => {
  it("merges adjacent dark modules per row", () => {
    const matrix = [
      [true, true, false, true],
      [false, false, false, false],
      [true, true, true, true],
    ];
    expect(qrRuns(matrix)).toEqual([
      { x: 0, y: 0, length: 2 },
      { x: 3, y: 0, length: 1 },
      { x: 0, y: 2, length: 4 },
    ]);
  });

  it("redraws a real rider-link QR code exactly, with fewer rects than modules", () => {
    const qr = encode(`https://verify.example.org/#s=${"A".repeat(43)}`, { ecc: "M", border: 0 });
    const runs = qrRuns(qr.data);
    expect(redraw(qr.size, runs)).toEqual(qr.data);
    const darkModules = qr.data.flat().filter(Boolean).length;
    expect(runs.length).toBeLessThan(darkModules);
  });
});
