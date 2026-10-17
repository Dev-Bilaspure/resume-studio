import assert from "node:assert/strict";
import { test } from "node:test";
import { jobInput, parseFrontMatter } from "./data.ts";
import { markdownReport, summarize } from "./report.ts";
import type { CaseResult } from "./run.ts";

test("front matter: fields and the posting's text", () => {
  const { fields, body } = parseFrontMatter('---\ncompany: Acme\nrole: "Backend Engineer, Payments"\nlevel: senior\n---\n\nWe build payments.\n');
  assert.deepEqual(fields, { company: "Acme", role: "Backend Engineer, Payments", level: "senior" });
  assert.equal(body, "We build payments.");
  assert.equal(jobInput({ id: "x", company: "Acme", role: "R", level: "new-grad", description: "d" }).seniority, "junior");
});

const screen = (tailoredAs: "A" | "B", advance: "A" | "B", tailoredFit: number, originalFit: number) => ({
  tailoredAs,
  result: tailoredAs === "A" ? { fitA: tailoredFit, fitB: originalFit, advance, reason: "" } : { fitA: originalFit, fitB: tailoredFit, advance, reason: "" },
});

function result(id: string, screens: ReturnType<typeof screen>[], issues: { severity: "high" | "medium" | "low" }[] = []): CaseResult {
  return {
    id,
    resume: "r",
    jd: id,
    posting: { company: "C", role: "R" },
    status: "ready",
    engine: {
      provider: "p",
      model: "m",
      seconds: 100,
      calls: 6,
      inputTokens: 0,
      outputTokens: 0,
      edits: 5,
      dropped: 1,
      flagged: 0,
      pagesBefore: 1,
      pagesAfter: 1,
      atsBefore: 90,
      atsAfter: 92,
      keywordsBefore: 3,
      keywordsAfter: 5,
      keywordsTotal: 8,
      strongBefore: 4,
      strongAfter: 6,
      requirements: 10,
    },
    audit: { issues: issues.map((i) => ({ kind: "invented_skill" as const, severity: i.severity, quote: "q", why: "w" })) },
    screens,
    judge: { provider: "p", model: "j" },
    finishedAt: "",
  };
}

test("summary: position-aware wins, fit change, audit counts", () => {
  const s = summarize([
    // Tailored advanced in both orders, +2 each time.
    result("a", [screen("B", "B", 8, 6), screen("A", "A", 8, 6)]),
    // Whichever came first won: a position effect, not a preference.
    result("b", [screen("B", "A", 6, 6), screen("A", "A", 6, 6)], [{ severity: "medium" }]),
    // Original advanced both times.
    result("c", [screen("B", "A", 5, 7), screen("A", "B", 5, 7)], [{ severity: "low" }, { severity: "high" }]),
  ]);
  assert.equal(s.screens, 6);
  assert.equal(s.tailoredAdvanced, 3);
  assert.deepEqual([s.tailoredWonBoth, s.splitByPosition, s.originalWonBoth], [1, 1, 1]);
  assert.equal(s.meanFitDelta, 0);
  assert.equal(s.audit.audited, 3);
  assert.equal(s.audit.clean, 1, "only the case with no high or medium issue is clean");
  assert.deepEqual([s.audit.high, s.audit.medium, s.audit.low], [1, 1, 1]);
});

test("the report renders", () => {
  const md = markdownReport([result("a", [screen("B", "B", 8, 6), screen("A", "A", 8, 6)])], { engine: "e", judge: "j", startedAt: "now" });
  assert.match(md, /tailored advanced \| 2 of 2 screens \(100%\)/);
  assert.match(md, /\| T, T \| \+2\.0 \|/);
});
