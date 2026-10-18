"use client";

// PDF.js is browser-only and large: load it once, on demand. The viewer module reads the core library
// from globalThis.pdfjsLib, so the core must be loaded (and published there) first.
//
// The "legacy" build: the modern one needs JavaScript features newer than current stable browsers ship
// (Map.prototype.getOrInsertComputed); legacy polyfills them. Rendering is identical.

type PdfjsLib = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type ViewerLib = typeof import("pdfjs-dist/legacy/web/pdf_viewer.mjs");

let loading: Promise<{ pdfjs: PdfjsLib; viewer: ViewerLib }> | null = null;

export function loadPdfjs() {
  return (loading ??= (async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
    (globalThis as unknown as { pdfjsLib: PdfjsLib }).pdfjsLib = pdfjs;
    const viewer = await import("pdfjs-dist/legacy/web/pdf_viewer.mjs");
    return { pdfjs, viewer };
  })().catch((e) => {
    loading = null;
    throw e;
  }));
}

/** Asset locations (copied into public/pdfjs by scripts/copy-pdfjs.mjs). */
export const DOCUMENT_OPTIONS = {
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  wasmUrl: "/pdfjs/wasm/",
  iccUrl: "/pdfjs/iccs/",
} as const;
