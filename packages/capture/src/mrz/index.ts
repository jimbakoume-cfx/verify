// Pixel side of MRZ ("code lines") reading: find the lines on the still and prepare them for OCR.
// The OCR engine, the character correction and the parsing live in the rider app.
export { MRZ_PRINT, expectedMrzCharHeight, fallbackMrzBand, locateMrzBand } from "./locate";
export type { MrzBand, MrzLayoutName } from "./locate";
export { PREPARE_DEFAULTS, prepareForOcr, rotateGray180 } from "./prepare";
export type { MrzBinarization, PrepareOptions } from "./prepare";
export { decodePgm, encodePgm } from "./pnm";
