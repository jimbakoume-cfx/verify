import { useMemo } from "react";
import { encode } from "uqr";
import { qrRuns } from "../lib/qr";

/** Modules of white margin a scanner needs around the code (ISO/IEC 18004 quiet zone). */
const QUIET_ZONE = 4;

/** QR code drawn as SVG elements by React (no innerHTML), black on white for any scanner. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { size, runs } = useMemo(() => {
    // Error correction M survives a smudged or partly reflective screen; the link stays short enough.
    const qr = encode(value, { ecc: "M", border: 0 });
    return { size: qr.size, runs: qrRuns(qr.data) };
  }, [value]);
  const total = size + QUIET_ZONE * 2;

  return (
    <svg className="dash-qr" viewBox={`0 0 ${total} ${total}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={total} height={total} fill="#ffffff" />
      {runs.map((run) => (
        <rect
          key={`${run.x}.${run.y}`}
          x={run.x + QUIET_ZONE}
          y={run.y + QUIET_ZONE}
          width={run.length}
          height={1}
          fill="#000000"
        />
      ))}
    </svg>
  );
}
