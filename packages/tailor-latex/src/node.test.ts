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

test("resume folders: read the main file, write a new folder, never over the original", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync: read, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { readResumeFolder, writeResumeFolder } = await import("./node.ts");
  const root = mkdtempSync(join(tmpdir(), "resume-folder-"));
  try {
    const orig = join(root, "cv");
    mkdirSync(join(orig, "sections"), { recursive: true });
    writeFileSync(join(orig, "resume.tex"), "\\documentclass{article}\\begin{document}\\input{sections/exp}\\end{document}");
    writeFileSync(join(orig, "sections/exp.tex"), "Built things.");
    writeFileSync(join(orig, "photo.png"), "PNG");
    writeFileSync(join(orig, "resume.aux"), "aux");

    const { dir, source } = readResumeFolder(orig);
    assert.equal(dir, orig);
    assert.equal(source.main, "resume.tex", "found by \\documentclass when there's no main.tex");
    assert.deepEqual(Object.keys(source.files).sort(), ["resume.tex", "sections/exp.tex"]);

    const out = writeResumeFolder(orig, join(root, "tailored"), { main: "resume.tex", files: { ...source.files, "sections/exp.tex": "Built better things." } }, { "jd.md": "# Job" });
    assert.equal(read(join(out, "sections/exp.tex"), "utf8"), "Built better things.");
    assert.equal(read(join(out, "photo.png"), "utf8"), "PNG", "assets come along");
    assert.ok(existsSync(join(out, "jd.md")));
    assert.ok(!existsSync(join(out, "resume.aux")), "build leftovers don't");
    assert.equal(read(join(orig, "sections/exp.tex"), "utf8"), "Built things.", "the original is untouched");

    assert.throws(() => writeResumeFolder(orig, orig, source), /never overwritten/);
    assert.throws(() => writeResumeFolder(orig, out, source), /isn't empty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
