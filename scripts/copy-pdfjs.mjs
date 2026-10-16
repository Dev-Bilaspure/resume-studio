// Copies the PDF.js worker and its runtime assets (CMaps for non-Latin text, the standard fonts for PDFs
// that don't embed them, ICC profiles and WASM image decoders) into public/pdfjs, so the viewer loads them
// from this app with versions that always match the installed pdfjs-dist.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkg = dirname(require.resolve("pdfjs-dist/package.json"));
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "pdfjs");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// Legacy build (see src/components/preview/pdfjs.ts); the worker must match the main library.
cpSync(join(pkg, "legacy", "build", "pdf.worker.min.mjs"), join(out, "pdf.worker.min.mjs"));
for (const dir of ["cmaps", "standard_fonts", "iccs", "wasm"]) cpSync(join(pkg, dir), join(out, dir), { recursive: true });
console.log(`pdfjs assets → ${out}`);
