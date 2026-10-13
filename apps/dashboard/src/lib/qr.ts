/** A horizontal run of dark modules on one row of a QR matrix. */
export interface QrRun {
  x: number;
  y: number;
  length: number;
}

/**
 * Merge each row's adjacent dark modules into runs, so the SVG has one <rect> per run instead of
 * one per module (a version 5 code drops from ~700 elements to ~300).
 */
export function qrRuns(matrix: readonly (readonly boolean[])[]): QrRun[] {
  const runs: QrRun[] = [];
  matrix.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x++) {
      const dark = x < row.length && row[x];
      if (dark && start < 0) start = x;
      if (!dark && start >= 0) {
        runs.push({ x: start, y, length: x - start });
        start = -1;
      }
    }
  });
  return runs;
}
