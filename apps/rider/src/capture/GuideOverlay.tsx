// Dark mask with a card-shaped cut-out, corner marks coloured by readiness, and a green border that
// fills up while auto-capture counts good frames. SVG in CSS pixels: sharp at any devicePixelRatio.
import type { Rect } from "@verify/capture";
import type { Size } from "./geometry";
import type { Readiness } from "./hints";

const f = (n: number) => n.toFixed(1);

function roundedRect({ x, y, width: w, height: h }: Rect, r: number): string {
  return (
    `M${f(x + r)} ${f(y)}H${f(x + w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(y + r)}` +
    `V${f(y + h - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w - r)} ${f(y + h)}` +
    `H${f(x + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y + h - r)}` +
    `V${f(y + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)}Z`
  );
}

function corners({ x, y, width: w, height: h }: Rect, r: number, len: number): string {
  const a = `A${f(r)} ${f(r)} 0 0 1`;
  return [
    `M${f(x)} ${f(y + len)}V${f(y + r)}${a} ${f(x + r)} ${f(y)}H${f(x + len)}`,
    `M${f(x + w - len)} ${f(y)}H${f(x + w - r)}${a} ${f(x + w)} ${f(y + r)}V${f(y + len)}`,
    `M${f(x + w)} ${f(y + h - len)}V${f(y + h - r)}${a} ${f(x + w - r)} ${f(y + h)}H${f(x + w - len)}`,
    `M${f(x + len)} ${f(y + h)}H${f(x + r)}${a} ${f(x)} ${f(y + h - r)}V${f(y + h - len)}`,
  ].join("");
}

interface Props {
  stage: Size;
  guide: Rect;
  readiness: Readiness;
  /** 0..1: share of the good frames auto-capture still needs. */
  progress: number;
}

export function GuideOverlay({ stage, guide, readiness, progress }: Props) {
  const { width: w, height: h } = stage;
  // ID-1 card corners have a 3.18 mm radius on 85.6 mm: about 3.7% of the width.
  const r = guide.width * 0.037;
  const len = Math.min(guide.width, guide.height) * 0.2;
  return (
    <svg className="guide-overlay" viewBox={`0 0 ${f(w)} ${f(h)}`} aria-hidden="true" focusable="false">
      <path className="guide-mask" fillRule="evenodd" d={`M0 0H${f(w)}V${f(h)}H0Z${roundedRect(guide, r)}`} />
      <path className="guide-frame" d={roundedRect(guide, r)} />
      {progress > 0 && (
        <path className="guide-progress" d={roundedRect(guide, r)} pathLength={1} strokeDasharray={`${progress} 1`} />
      )}
      <path className={`guide-corners ${readiness}`} d={corners(guide, r, len)} />
    </svg>
  );
}
