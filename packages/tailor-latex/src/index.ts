// @resume-studio/tailor-latex: the LaTeX format adapter for @resume-studio/tailor. Maps a .tex resume
// (with \input files, custom section/item macros, custom list environments) to the engine's document
// and applies edits to exactly the text they change; everything else stays byte-for-byte the same.
export { latexToMarkup, latexToPlain, markupToLatex } from "./convert.ts";
export { applyLatex, latexAdapter, parseLatex, type EditLocation, type Parsed } from "./latex.ts";
