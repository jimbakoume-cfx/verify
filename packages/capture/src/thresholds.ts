import type { QualityThresholds } from "./types";

/**
 * Starting thresholds, calibrated on the synthetic images of `calibration.test.ts`: analysis image
 * 480 px wide, guide 400 px wide, an ID-1 card with text, a portrait and MRZ-like lines. The
 * measured values are listed next to each threshold. Real-phone calibration happens during the
 * PM's tests; override any value with `{ ...DEFAULT_THRESHOLDS, minSharpness: 8 }`.
 * README.md explains each check in plain language.
 */
export const DEFAULT_THRESHOLDS: Readonly<QualityThresholds> = Object.freeze({
  // `focus`: fine detail of the card smoothed by sigma 1 px, minus whatever a bell-shaped (noise)
  // response explains, at a standard contrast (see laplacianDetail). Sharp card: 70-90. Gaussian
  // blur sigma 1 px (at analysis size; ~3 px in the final photo, still readable): 30 clean, 19-25
  // with phone-like correlated grain, at least 6 for a dark card in dim light with heavy grain.
  // Fail: sigma 2: at most 4.4 whatever the grain or light (box blur radius 3: 4). Sigma 1.5 is
  // borderline (10 clean, 3-7 with grain or dim light). The grain is measured with the very
  // operator that measures detail, so neither white nor spatially correlated grain helps a
  // blurred card (sigma 2.5 + correlated grain 5, at 0.6x exposure: 0).
  minSharpness: 5,
  // Diffuse glare: more than 2% of the card blown out, even if spread thin.
  maxGlareRatio: 0.02,
  // A hotspot: more than 3.5% of any tile (1/16 of the card) blown out. A saturated disc of
  // radius 6 px (~2.5 mm on a card, about one character) gives 2.0% and passes; radius 9 px
  // (~4 mm, two or three characters) gives 4.5% and fails.
  maxGlareTileRatio: 0.035,
  // Mean brightness of the card. The light test card averages 186, the darker one 92. A third of
  // normal exposure (light card 47, darker card at half exposure 46) is too dark: noise and lost
  // contrast; 0.35 of normal (65) still passes.
  minMeanLuma: 50,
  // Above this the card is mostly near clipping (1.15x exposure + 10: 224 with 17% blown out).
  // A white card in good light averages 200-215.
  maxMeanLuma: 225,
  // Card area / guide area. 0.7 = the card spans about 84% of the guide's width: still ~1300 px
  // across in a 1600 px photo. 90% of the guide (0.81) passes, 80% (0.64) asks to move closer.
  minFraming: 0.7,
  // The final photo is the guide plus 2% on each side (4% in total), so a card sticking out by
  // more than 2% would be cut. 1.5% leaves half a percent (2 px at analysis size) for detection
  // error: a card at 102% of the guide passes, from 103% it asks to move back.
  maxOvershoot: 0.015,
  // Card centre to guide centre, as a share of the guide width. 8%: a card at the minimum size
  // (84% of the guide) can drift this far and still sit inside the guide.
  maxCenterOffset: 0.08,
  // Beyond this tilt (degrees either way) the rider is asked to straighten the card
  // (center_document): the photo would show a crooked card with background in its corners.
  // Detection itself measures tilt up to ~12 degrees (within half a degree on the synthetic card).
  maxTiltDeg: 4,
  // Mean absolute difference between frames, after removing what sensor noise explains (the
  // larger of the spatial estimate and the noise seen between the two frames, see temporalNoise).
  // Shifting the light test card (95% of the guide) by 1 px: 5.0; 2 px: 6.9; 4 px: 9.7. The darker
  // card changes less (90% of the guide: 2.3 / 3.5 / 5.2; 8 px: 8.2). Fresh grain in every frame,
  // white up to 8 levels or correlated (std 6, 3x3): about 0 after the discount, and 1 px of
  // tremor in it stays below 5. 2 px between frames (1/8 s) is ordinary hand tremor.
  maxMotion: 7,
  // At ~8 analysis frames per second, 5 good frames in a row = about 0.6 s of holding steady.
  stableFramesRequired: 5,
  // detectDocumentBox confidence. Synthetic cards on plain, noisy or similar-coloured tables (15+
  // levels apart) score 1.0; plain and noisy backgrounds without a card 0; clutter without a card
  // at most 0.41 (40 scenes). Cards closer than ~12 levels to the table's brightness fall below.
  minDocumentConfidence: 0.5,
});
