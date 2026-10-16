import assert from "node:assert/strict";
import { test } from "node:test";
import { attributeToUsepackage, parseLog } from "../logparser.ts";

const root = "/Users/me/resumes/acme";

const LOG = `This is pdfTeX, Version 3.141592653-2.6-1.40.27 (TeX Live 2026) (preloaded format=pdflatex 2026.4.1)  16 OCT 2026 12:00
entering extended mode
 restricted \\write18 enabled.
**main.tex
(./main.tex
LaTeX2e <2025-11-01>
(/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls
Document Class: article 2024/06/29 v1.4n Standard LaTeX document class
(/usr/local/texlive/2026/texmf-dist/tex/latex/base/size11.clo))
(/usr/local/texlive/2026/texmf-dist/tex/latex/geometry/geometry.sty)
./main.tex:42: Undefined control sequence.
l.42 \\textbff
              {Senior Engineer}
The control sequence at the end of the top line
of your error message was never \\def'ed.

LaTeX Warning: Reference \`sec:exp' on page 1 undefined on input line 57.

(./sections/experience.tex
Overfull \\hbox (12.34567pt too wide) in paragraph at lines 9--11
[]\\T1/XCharter-TLF/m/n/10.95 Built a streaming pipeline|
Underfull \\hbox (badness 10000) in paragraph at lines 14--14
)
Package hyperref Warning: Token not allowed in a PDF string (Unicode):
(hyperref)                removing \`math shift' on input line 61.

./main.tex:80: LaTeX Error: File \`fontawesome7.sty' not found.

Type X to quit or <RETURN> to proceed,
or enter new name. (Default extension: sty)

Enter file name:
! Emergency stop.
<read *>

l.80 \\usepackage
                {fontawesome7}^^M
*** (cannot \\read from terminal in nonstop modes)
`;

test("file:line errors with context and hints", () => {
  const d = parseLog(LOG, { rootDir: root });
  const undef = d.find((x) => x.message.startsWith("Undefined control sequence"));
  assert.ok(undef);
  assert.equal(undef.severity, "error");
  assert.equal(undef.file, "main.tex");
  assert.equal(undef.line, 42);
  assert.match(undef.detail ?? "", /\\textbff ⟨here⟩ \{Senior Engineer\}/);
  assert.match(undef.detail ?? "", /command isn't defined/);

  const missing = d.find((x) => x.message.includes("fontawesome7.sty"));
  assert.ok(missing);
  assert.equal(missing.line, 80);
  assert.match(missing.detail ?? "", /tlmgr install fontawesome7/);
});

test("warnings get the file from TeX's open-file nesting", () => {
  const d = parseLog(LOG, { rootDir: root });
  const ref = d.find((x) => x.kind === "reference");
  assert.ok(ref);
  assert.equal(ref.file, "main.tex");
  assert.equal(ref.line, 57);

  const box = d.find((x) => x.kind === "box" && x.severity === "warning");
  assert.ok(box);
  assert.equal(box.file, "sections/experience.tex");
  assert.equal(box.line, 9);
  assert.match(box.message, /overflows the right margin by 12.3pt/);

  const pkg = d.find((x) => x.kind === "package");
  assert.ok(pkg);
  assert.equal(pkg.file, "main.tex"); // experience.tex was closed by ")"
  assert.equal(pkg.line, 61);
  assert.match(pkg.message, /^hyperref: Token not allowed in a PDF string \(Unicode\): removing `math shift'$/);
});

test("underfull boxes are notes, errors sort first, emergency stop is kept once", () => {
  const d = parseLog(LOG, { rootDir: root });
  assert.equal(d[0].severity, "error");
  assert.ok(d.some((x) => x.kind === "box" && x.severity === "info"));
  assert.equal(d.filter((x) => x.message === "Emergency stop").length, 1);
});

test("files outside the resume are not linked", () => {
  const d = parseLog("/usr/local/texlive/2026/texmf-dist/tex/latex/foo/foo.sty:12: Package foo Error: bad option.\n", { rootDir: root });
  assert.equal(d[0].file, null);
  assert.equal(d[0].kind, "package");
});

test("absolute paths inside the resume become relative", () => {
  const d = parseLog(`${root}/./parts/skills.tex:3: Missing $ inserted.\nl.3 C_\n      ++\n`, { rootDir: root });
  assert.equal(d[0].file, "parts/skills.tex");
  assert.equal(d[0].line, 3);
  assert.match(d[0].detail ?? "", /Escape it as \\_/);
});

test("rerun notices are dropped", () => {
  const d = parseLog("(./main.tex\nLaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.\n)", { rootDir: root });
  assert.equal(d.length, 0);
});

test("errors inside a package point at the \\usepackage that loaded it", () => {
  const log = `(./main.tex
(/usr/local/texlive/2026/texmf-dist/tex/latex/xcharter/XCharter.sty
/usr/local/texlive/2026/texmf-dist/tex/latex/xcharter/XCharter.sty:23: LaTeX Error: File \`scalefnt.sty' not found.

Type X to quit or <RETURN> to proceed,
or enter new name. (Default extension: sty)

Enter file name:
/usr/local/texlive/2026/texmf-dist/tex/latex/xcharter/XCharter.sty:23: Emergency stop.
<read *>

l.23 \\RequirePackage
                   {scalefnt}^^M
/usr/local/texlive/2026/texmf-dist/tex/latex/xcharter/XCharter.sty:23:  ==> Fatal error occurred, no output PDF file produced!
`;
  const src = "\\documentclass{article}\n% \\usepackage{XCharter} (old)\n\\usepackage[T1]{fontenc}\n\\usepackage[sups]{XCharter}\n";
  const d = attributeToUsepackage(parseLog(log, { rootDir: root }), { "main.tex": src });
  assert.equal(d.filter((x) => /Fatal error/.test(x.message)).length, 0);
  const missing = d.find((x) => x.message.includes("scalefnt.sty"));
  assert.ok(missing);
  assert.equal(missing.file, "main.tex");
  assert.equal(missing.line, 4); // not the commented-out line 2
  assert.equal(missing.origin, "XCharter.sty");
  assert.match(missing.detail ?? "", /Raised inside XCharter.sty, loaded here/);
});

test("fontspec documents build with XeLaTeX unless told otherwise", async () => {
  const { effectiveEngine } = await import("../engine.ts");
  const fontspec = "\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{Arial}\n\\begin{document}\nx\n\\end{document}";
  assert.equal(effectiveEngine(fontspec, "pdflatex"), "xelatex");
  assert.equal(effectiveEngine(fontspec, "lualatex"), "lualatex");
  assert.equal(effectiveEngine("% !TEX program = lualatex\n" + fontspec, "pdflatex"), "lualatex");
  assert.equal(effectiveEngine("\\documentclass{article}\n% \\usepackage{fontspec}\n\\begin{document}\\end{document}", "pdflatex"), "pdflatex");
  assert.equal(effectiveEngine("\\documentclass{article}\n\\begin{document}\n\\usepackage{fontspec} in text\n\\end{document}", "pdflatex"), "pdflatex");
});
