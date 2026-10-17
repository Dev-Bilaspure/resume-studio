import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { latexEngine, latexmkVerifier } from "./node.ts";

const classic = readFileSync(new URL("./fixtures/classic.tex", import.meta.url), "utf8");
const hasTex = (() => {
  try {
    execFileSync("latexmk", ["-v"], { env: { ...process.env, PATH: `/Library/TeX/texbin:/opt/homebrew/bin:${process.env.PATH}` }, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("picks the engine the document needs", () => {
  assert.equal(latexEngine({ main: "main.tex", files: { "main.tex": classic } }), "-pdf");
  assert.equal(latexEngine({ main: "main.tex", files: { "main.tex": "\\usepackage{fontspec}" } }), "-xelatex");
  assert.equal(latexEngine({ main: "main.tex", files: { "main.tex": "% !TEX program = lualatex\n" } }), "-lualatex");
  assert.equal(latexEngine({ main: "main.tex", files: { "main.tex": "% \\usepackage{fontspec}" } }), "-pdf", "commented-out packages don't count");
});

test("builds a resume: pages, text, no errors", { skip: !hasTex && "TeX isn't installed" }, async () => {
  const r = await latexmkVerifier().build({ main: "main.tex", files: { "main.tex": classic } }, { maxPages: 1 });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.pages, 1);
  assert.ok((r.text ?? "").length > 500, "the PDF's text is extracted");
});

test("a broken draft fails with the line of the error", { skip: !hasTex && "TeX isn't installed" }, async () => {
  const broken = "\\documentclass{article}\n\\begin{document}\nfine\n\n\\undefinedmacro\n\\end{document}\n";
  const r = await latexmkVerifier().build({ main: "main.tex", files: { "main.tex": broken } }, {});
  assert.equal(r.ok, false);
  assert.equal(r.errors[0]?.line, 5);
  assert.match(r.errors[0]?.message ?? "", /Undefined control sequence/);
});
