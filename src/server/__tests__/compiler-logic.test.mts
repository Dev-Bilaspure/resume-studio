import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveEngine, localDependencies, rankMainCandidates } from "../engine.ts";
import { parseBibLog, parseLog } from "../logparser.ts";

const doc = (preamble: string) => `\\documentclass{article}\n${preamble}\n\\begin{document}\nx\n\\end{document}`;

test("engine: PSTricks → LaTeX (DVI), Lua code → LuaLaTeX, .xtx → XeLaTeX", () => {
  assert.equal(effectiveEngine(doc("\\usepackage{pstricks}"), "pdflatex"), "latex");
  assert.equal(effectiveEngine(doc("\\usepackage{pst-node}"), "pdflatex"), "latex");
  assert.equal(effectiveEngine(doc("\\usepackage{pstricks}\\usepackage{auto-pst-pdf}"), "pdflatex"), "pdflatex");
  assert.equal(effectiveEngine(doc("\\usepackage{luacode}"), "pdflatex"), "lualatex");
  assert.equal(effectiveEngine(doc("\\directlua{tex.print('x')}"), "pdflatex"), "lualatex");
  assert.equal(effectiveEngine(doc(""), "pdflatex", "deedy.xtx"), "xelatex");
});

test("engine: fontspec loaded by the project's own class counts", () => {
  const cls = "\\NeedsTeXFormat{LaTeX2e}\\ProvidesClass{awesome-cv}\\RequirePackage{fontspec}";
  const main = "\\documentclass[11pt]{awesome-cv}\n\\begin{document}x\\end{document}";
  assert.equal(effectiveEngine(main, "pdflatex", "examples/cv.tex", [cls]), "xelatex");
  assert.deepEqual(localDependencies("\\documentclass[a4paper]{awesome-cv}\n\\usepackage{a,b}\n% \\usepackage{c}"), {
    classes: ["awesome-cv"],
    packages: ["a", "b"],
  });
});

test("main file ranking picks the document, not the manual or the letter", () => {
  assert.equal(rankMainCandidates(["examples/coverletter.tex", "examples/cv.tex", "examples/resume.tex"])[0], "examples/resume.tex");
  assert.equal(rankMainCandidates(["manual/moderncv_userguide.tex", "examples/template.tex", "examples/template-zh.tex"])[0], "examples/template.tex");
  assert.equal(rankMainCandidates(["legacy/sample-old.tex", "mmayer.tex", "sample.tex"])[0], "sample.tex");
  assert.equal(rankMainCandidates(["OpenFonts/deedy_resume-openfont.xtx", "MacFonts/deedy_resume.xtx"])[0], "MacFonts/deedy_resume.xtx");
  assert.equal(rankMainCandidates(["x.tex", "main.tex"])[0], "main.tex");
});

test("log paths are relative to the main file's folder (latexmk -cd)", () => {
  const log = "(./resume.tex\n(./resume/education.tex\n./resume/education.tex:4: Undefined control sequence.\nl.4 \\foo\n         \n))";
  const d = parseLog(log, { rootDir: "/b/proj", cwd: "examples" });
  assert.equal(d[0].file, "examples/resume/education.tex");
  assert.equal(d[0].line, 4);
  assert.equal(parseLog("../outside.tex:1: Undefined control sequence.\n", { rootDir: "/b/proj" })[0].file, null);
});

test("biber and BibTeX problems become diagnostics", () => {
  const biber = [
    "[0] Config.pm:307> INFO - This is Biber 2.20",
    "[85] Utils.pm:411> WARN - I didn't find a database entry for 'nope2020' (section 0)",
    '[90] Utils.pm:411> ERROR - BibTeX subsystem: /var/folders/x/biber_tmp_abc/refs.bib_12345.utf8, line 7, syntax error: found "}", expected end of entry',
  ].join("\n");
  const d = parseBibLog(biber, { rootDir: "/b/proj" });
  assert.equal(d[0].severity, "warning");
  assert.match(d[0].message, /No bibliography entry for “nope2020”/);
  assert.equal(d[1].severity, "error");
  assert.equal(d[1].file, "refs.bib");
  assert.equal(d[1].line, 7);

  const bibtex = "Warning--I didn't find a database entry for \"knuth\"\nI was expecting a `,' or a `}'---line 5 of file refs.bib\n";
  const b = parseBibLog(bibtex, { rootDir: "/b/proj" });
  assert.match(b[0].message, /No bibliography entry for “knuth”/);
  assert.deepEqual([b[1].file, b[1].line, b[1].severity], ["refs.bib", 5, "error"]);
});

test("shell-escape errors suggest trusting the project", () => {
  const d = parseLog("./main.tex:3: Package minted Error: You must invoke LaTeX with the -shell-escape flag.\n", { rootDir: "/b/proj" });
  assert.match(d[0].detail ?? "", /Trusted project/);
});

test("fonts requested by name, not by file", async () => {
  const { requestedFonts, fontKey } = await import("../engine.ts");
  const code = String.raw`\setmainfont{Roboto Slab}[BoldFont=* Bold]
\setsansfont[Scale=0.9]{Lato}
\newfontfamily\headingfont{Source Sans 3}
\newfontfamily{\bodyfont}{Fira Sans Light}
\setmonofont{Inconsolata.otf}
\setmainfont{Lato}[Path=fonts/, Extension=.ttf]
% \setmainfont{Commented Out}
\fontspec{#1}`;
  assert.deepEqual(requestedFonts(code), ["Roboto Slab", "Lato", "Source Sans 3", "Fira Sans Light"]);
  assert.equal(fontKey("Source Sans 3"), fontKey("SourceSans3"));
});

test("XeTeX-only packages rule out the LuaLaTeX fallback", async () => {
  const { needsXeTeX } = await import("../engine.ts");
  assert.equal(needsXeTeX("\\usepackage{fontspec,xltxtra,xunicode}"), true);
  assert.equal(needsXeTeX("\\usepackage{fontspec}\\usepackage{polyglossia}"), false);
  assert.equal(needsXeTeX("% \\usepackage{xunicode}\n\\usepackage{fontspec}"), false);
});
