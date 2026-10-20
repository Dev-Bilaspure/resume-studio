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

const screen = (advance: boolean, fit: number, shown: number) => ({
  advance,
  fit,
  shown: Array.from({ length: shown }, (_, i) => `m${i}`),
  missing: [],
  reason: "r",
});

function result(
  id: string,
  original: ReturnType<typeof screen>,
  tailored: ReturnType<typeof screen>,
  issues: { severity: "high" | "medium" | "low" }[] = [],
): CaseResult {
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
      atsBefore: null,
      atsAfter: null,
      keywordsBefore: 3,
      keywordsAfter: 5,
      keywordsTotal: 8,
      strongBefore: 4,
      strongAfter: 6,
      requirements: 10,
    },
    audit: { issues: issues.map((i) => ({ kind: "invented_skill" as const, severity: i.severity, quote: "q", why: "w" })) },
    screen: { original, tailored },
    judge: { provider: "p", model: "j" },
    finishedAt: "",
  };
}

test("summary: advance rates, gains and losses, fit change, audit counts", () => {
  const s = summarize([
    result("a", screen(false, 5, 2), screen(true, 7, 4)),
    result("b", screen(true, 7, 3), screen(true, 7, 3), [{ severity: "medium" }]),
    result("c", screen(true, 6, 3), screen(false, 5, 2), [{ severity: "low" }, { severity: "high" }]),
    result("d", screen(false, 3, 1), screen(false, 4, 1)),
  ]);
  assert.deepEqual([s.screened, s.originalAdvanced, s.tailoredAdvanced, s.gained, s.lost], [4, 2, 2, 1, 1]);
  assert.equal(s.meanFitDelta, 0.5);
  assert.deepEqual([s.meanShownBefore, s.meanShownAfter], [2.25, 2.5]);
  assert.equal(s.audit.clean, 2, "only cases with no high or medium issue are clean");
  assert.deepEqual([s.audit.high, s.audit.medium, s.audit.low], [1, 1, 1]);
});

test("the report renders, with the decisions that changed", () => {
  const md = markdownReport([result("a", screen(false, 5, 2), screen(true, 7, 4))], { engine: "e", judge: "j", startedAt: "now" });
  assert.match(md, /original → tailored \| 0 → 1 of 1 \(0% → 100%\)/);
  assert.match(md, /\| – \| no → yes \| 5 → 7 \| 2 → 4 \|/);
  assert.match(md, /\*\*a\*\* \(gained\)/);
});
