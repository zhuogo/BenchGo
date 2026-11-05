import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs';
export function load(bytes, workerUrl) {
  GlobalWorkerOptions.workerSrc = workerUrl;
  const root = new URL('./', workerUrl).href;
  return getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true, cMapUrl: root + 'cmaps/', cMapPacked: true, standardFontDataUrl: root + 'standard_fonts/', wasmUrl: root + 'wasm/' });
}
