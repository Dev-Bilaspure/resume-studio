import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSynctexEdit, parseSynctexView } from "../synctex-parse.ts";

test("synctex view records become boxes (deduplicated)", () => {
  const out = `This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:/x/1.pdf
Page:1
x:72.000000
y:150.000000
h:43.200001
v:151.500000
W:525.599976
H:9.800000
before:
offset:0
middle:
after:
Output:/x/1.pdf
Page:1
x:80.000000
y:150.000000
h:43.200001
v:151.500000
W:525.599976
H:9.800000
SyncTeX result end
`;
  const boxes = parseSynctexView(out);
  assert.equal(boxes.length, 1);
  assert.deepEqual(boxes[0], { page: 1, h: 43.200001, v: 151.5, width: 525.599976, height: 9.8 });
});

test("synctex edit maps back to a path relative to the resume", () => {
  const out =
    "SyncTeX result begin\nOutput:/x/1.pdf\nInput:/Users/me/resumes/acme/./sections/exp.tex\nLine:12\nColumn:-1\nOffset:0\nContext:\nSyncTeX result end\n";
  assert.deepEqual(parseSynctexEdit(out, "/Users/me/resumes/acme/"), { file: "sections/exp.tex", line: 12, column: 0 });
  assert.equal(parseSynctexEdit(out.replace("/Users/me/resumes/acme/./", "/usr/local/texlive/"), "/Users/me/resumes/acme/"), null);
});
