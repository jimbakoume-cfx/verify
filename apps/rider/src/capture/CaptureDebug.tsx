// ?debug=1: live analysis values on top of the camera, for tuning thresholds on real phones.
import { useTranslation } from "react-i18next";
import type { AnalysisResult } from "./protocol";

export interface LiveDebug {
  result: AnalysisResult | null;
  fps: number;
  mode: "worker" | "main";
  video: { width: number; height: number };
}

const n = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits);

export function CaptureDebug({ live }: { live: LiveDebug }) {
  const { t } = useTranslation();
  const m = live.result?.metrics;
  const rows: [string, string][] = [
    [t("debug.mode"), live.mode],
    [t("debug.video"), `${live.video.width}×${live.video.height}`],
    [t("debug.fps"), n(live.fps, 1)],
    [t("debug.ms"), n(live.result?.ms, 1)],
    [t("debug.sharpness"), n(m?.sharpness)],
    [t("debug.focus"), n(m?.focus, 1)],
    [t("debug.noise"), n(m?.noise, 1)],
    [t("debug.glare"), m ? `${n(m.glareRatio * 100, 2)}%` : "—"],
    [t("debug.glareTile"), m ? `${n(m.glareTileRatio * 100, 2)}%` : "—"],
    [t("debug.luma"), n(m?.meanLuma)],
    [t("debug.framing"), n(m?.framing, 2)],
    [t("debug.offset"), m ? `${n(m.centerOffset * 100, 1)}% / ${n(m.overshoot * 100, 1)}%` : "—"],
    [t("debug.confidence"), n(m?.documentConfidence, 2)],
    [t("debug.tilt"), m?.documentBox ? `${n(m.documentAngle, 1)}°` : "—"],
    [t("debug.motion"), n(m?.motion, 1)],
    [t("debug.hints"), live.result ? live.result.hints.join(", ") || "ok" : "—"],
  ];
  return (
    <dl className="capture-debug" aria-hidden="true">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
