import assert from "node:assert/strict";
import { test } from "node:test";
import { bulletPoints, parsePdffonts, parsePdfinfo, runAtsChecks, stripComment, type AtsInput } from "../ats-checks.ts";

const GOOD_TEXT = `Alex Morgan
Senior Software Engineer
San Francisco, CA | alex.morgan@example.com | (415) 555-0134 | linkedin.com/in/alexmorgan
Summary
Backend engineer with 8 years building high-throughput distributed systems in Go and Kubernetes.
Experience
Senior Software Engineer Mar 2022 – Present
Foo Payments San Francisco, CA
• Cut p99 checkout latency from 480 ms to 120 ms by moving synchronous fraud checks to Kafka consumers.
• Led a team of 5 to migrate 40 services from VMs to Kubernetes (EKS), reducing infrastructure cost by 32%.
• Designed an idempotent ledger API in Go handling 12k requests per second at 99.99% availability.
Education
B.S. Computer Science 2014 – 2018
Skills
Languages: Go, Python, Java, SQL
${"Built reliable systems with measurable impact across teams and products. ".repeat(25)}`;

const FONTS = [{ name: "XCharter-Roman", type: "Type 1", embedded: true, unicodeMap: true }];

function input(over: Partial<AtsInput> = {}): AtsInput {
  return {
    text: GOOD_TEXT,
    pages: 1,
    fileSizeKB: 60,
    fonts: FONTS,
    title: "Alex Morgan — Resume",
    author: "Alex Morgan",
    sources: { "main.tex": "\\section{Experience}\n" },
    mainFile: "main.tex",
    ...over,
  };
}

const status = (r: ReturnType<typeof runAtsChecks>, id: string) => r.checks.find((c) => c.id === id)?.status;

test("a clean resume scores high and passes the key checks", () => {
  const r = runAtsChecks(input());
  assert.ok(r.score >= 95, `score ${r.score}`);
  for (const id of [
    "text-extractable",
    "unicode-map",
    "contact-email",
    "contact-phone",
    "contact-linkedin",
    "section-experience",
    "section-education",
    "section-skills",
    "ligatures",
    "columns",
  ]) {
    assert.equal(status(r, id), "pass", id);
  }
});

test("ligatures, icons and hyphenated keywords are flagged", () => {
  const r = runAtsChecks(input({ text: GOOD_TEXT.replace("services", "serv\uFB01ces") + "\nKuber-\nnetes \uF0E0 email" }));
  assert.equal(status(r, "ligatures"), "warn");
  assert.equal(status(r, "icons"), "warn");
  assert.equal(status(r, "hyphenation"), "warn");
});

test("missing unicode maps, bitmap fonts and no email are failures", () => {
  const r = runAtsChecks(
    input({
      text: GOOD_TEXT.replace("alex.morgan@example.com", ""),
      fonts: [
        { name: "CMR10", type: "Type 1", embedded: true, unicodeMap: false },
        { name: "T3Font_0", type: "Type 3", embedded: true, unicodeMap: false },
      ],
    }),
  );
  assert.equal(status(r, "unicode-map"), "fail");
  assert.equal(status(r, "type3"), "warn");
  assert.equal(status(r, "contact-email"), "fail");
  assert.ok(r.score < 75, `score ${r.score}`);
});

test("source checks point at the line, ignoring comments", () => {
  const sources = {
    "main.tex": "% \\begin{multicols}{2} (commented out)\n\\usepackage{multicol}\n\\begin{document}\n\\begin{multicols}{2}\n\\begin{tabular}{ll}\n",
  };
  const r = runAtsChecks(input({ sources }));
  const cols = r.checks.find((c) => c.id === "columns");
  assert.equal(cols?.status, "warn");
  assert.equal(cols?.line, 4);
  assert.equal(r.checks.find((c) => c.id === "tables")?.line, 5);
});

test("a year range is not a phone number", () => {
  const r = runAtsChecks(input({ text: GOOD_TEXT.replace("(415) 555-0134", "") }));
  assert.equal(status(r, "contact-phone"), "warn");
});

test("mixed date formats warn", () => {
  const r = runAtsChecks(input({ text: GOOD_TEXT + "\nJun 2018 – 02/2022" }));
  assert.equal(status(r, "dates"), "warn");
});

test("default PDF titles are flagged", () => {
  assert.equal(status(runAtsChecks(input({ title: "main" })), "metadata"), "warn");
});

test("stripComment keeps escaped percent signs", () => {
  assert.equal(stripComment("cut cost by 32\\% % note"), "cut cost by 32\\% ");
});

test("pdffonts and pdfinfo parsing", () => {
  const out = `name                                 type              encoding         emb sub uni object ID
------------------------------------ ----------------- ---------------- --- --- --- ---------
ABCDEF+XCharter-Bold                 Type 1            Custom           yes yes yes      7  0
GHIJKL+XCharter-Roman                Type 1            Custom           yes yes no       9  0
Helvetica                            Type 1            WinAnsi          no  no  no      11  0
`;
  const fonts = parsePdffonts(out);
  assert.deepEqual(fonts[0], { name: "XCharter-Bold", type: "Type 1", embedded: true, unicodeMap: true });
  assert.equal(fonts[1].unicodeMap, false);
  assert.equal(fonts[2].embedded, false);
  const info = parsePdfinfo("Title:           Alex Morgan — Resume\nPages:           1\nPage size:       612 x 792 pts (letter)\n");
  assert.equal(info.Title, "Alex Morgan — Resume");
  assert.equal(info.Pages, "1");
});

test("pdffonts rows whose long names overflow the column", () => {
  const out = `name                                 type              encoding         emb sub uni object ID
------------------------------------ ----------------- ---------------- --- --- --- ---------
QSTZNV+ArialMT                       CID TrueType      Identity-H       yes yes yes      4  0
GGTCHE+FontAwesome5Free-Solid-Identity-H CID Type 0C       Identity-H       yes yes no       8  0
GNCLEN+CMSY10                        Type 1C           Builtin          yes yes yes     10  0
`;
  const fonts = parsePdffonts(out);
  assert.deepEqual(fonts[0], { name: "ArialMT", type: "CID TrueType", embedded: true, unicodeMap: true });
  assert.deepEqual(fonts[1], { name: "FontAwesome5Free-Solid", type: "CID Type 0C", embedded: true, unicodeMap: false });
  assert.equal(fonts[2].type, "Type 1C");
  // An icon font without Unicode is an icon problem, not a "text can't be read" failure.
  const r = runAtsChecks(input({ fonts }));
  assert.equal(r.checks.find((c) => c.id === "unicode-map")?.status, "pass");
  assert.equal(r.checks.find((c) => c.id === "fonts-embedded")?.status, "pass");
});

test("wrapped bullets are read whole", () => {
  const b = bulletPoints("Experience\n• Built a pipeline that cut\nfailures by 60%.\n• Second one\nSkills\nGo");
  assert.deepEqual(b, ["• Built a pipeline that cut failures by 60%.", "• Second one"]);
});
