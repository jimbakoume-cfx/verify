// Computes the rider app's own quality measurements (packages/capture) on gray analysis images, so
// the Python port can be compared with the original on the same pixels. Bundled with rolldown and
// run by tests/tools/make_quality_reference.py; not part of any app.
//   node quality_reference.mjs <list.json>   (list: [{ name, width, height, pgm }])
import { readFileSync } from "node:fs";
import { analyzeFrame, decodePgm, guideInStill } from "../../../packages/capture/src/index.ts";

const list = JSON.parse(readFileSync(process.argv[2], "utf8")) as { name: string; pgm: string }[];
const out = list.map(({ name, pgm }) => {
  const gray = decodePgm(new Uint8Array(readFileSync(pgm)));
  const guide = guideInStill(gray.width, gray.height);
  const { metrics } = analyzeFrame(gray, guide, null);
  return {
    name,
    width: gray.width,
    height: gray.height,
    guide,
    metrics: {
      sharpness: metrics.sharpness,
      noise: metrics.noise,
      contrast: metrics.contrast,
      focus: metrics.focus,
      glareRatio: metrics.glareRatio,
      glareTileRatio: metrics.glareTileRatio,
      meanLuma: metrics.meanLuma,
      documentBox: metrics.documentBox,
      documentConfidence: metrics.documentConfidence,
      documentAngle: metrics.documentAngle,
      documentExtent: metrics.documentExtent,
    },
  };
});
process.stdout.write(JSON.stringify(out, null, 1) + "\n");
