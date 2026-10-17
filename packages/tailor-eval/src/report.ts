// Aggregates case results into the numbers that answer "does tailoring help, and is it honest?".
import type { CaseResult } from "./run.ts";

export interface Summary {
  cases: number;
  ready: number;
  failed: number;
  /** Cases screened (both versions judged on their own). */
  screened: number;
  originalAdvanced: number;
  tailoredAdvanced: number;
  /** Not advanced as written, advanced once tailored, and the reverse. */
  gained: number;
  lost: number;
  /** Mean of (tailored fit − original fit), 1–10 scale. */
  meanFitDelta: number | null;
  /** Mean number of the posting's must-haves the recruiter saw, before and after. */
  meanShownBefore: number | null;
  meanShownAfter: number | null;
  audit: { audited: number; clean: number; high: number; medium: number; low: number; byKind: Record<string, number> };
  /** Gap questions asked, answered from the candidate's history, and facts learned. */
  questionsAsked: number;
  questionsAnswered: number;
  factsLearned: number;
  pagesKept: number;
  meanSeconds: number | null;
  meanCalls: number | null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function summarize(results: CaseResult[]): Summary {
  const ready = results.filter((r) => r.status === "ready");
  const screened = ready.filter((r) => r.screen);
  const sc = screened.map((r) => r.screen!);
  const audited = ready.filter((r) => r.audit);
  const issues = audited.flatMap((r) => r.audit!.issues);
  const byKind: Record<string, number> = {};
  for (const i of issues) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
  return {
    cases: results.length,
    ready: ready.length,
    failed: results.length - ready.length,
    screened: sc.length,
    originalAdvanced: sc.filter((s) => s.original.advance).length,
    tailoredAdvanced: sc.filter((s) => s.tailored.advance).length,
    gained: sc.filter((s) => !s.original.advance && s.tailored.advance).length,
    lost: sc.filter((s) => s.original.advance && !s.tailored.advance).length,
    meanFitDelta: mean(sc.map((s) => s.tailored.fit - s.original.fit)),
    meanShownBefore: mean(sc.map((s) => s.original.shown.length)),
    meanShownAfter: mean(sc.map((s) => s.tailored.shown.length)),
    audit: {
      audited: audited.length,
      clean: audited.filter((r) => !r.audit!.issues.some((i) => i.severity !== "low")).length,
      high: issues.filter((i) => i.severity === "high").length,
      medium: issues.filter((i) => i.severity === "medium").length,
      low: issues.filter((i) => i.severity === "low").length,
      byKind,
    },
    questionsAsked: ready.reduce((n, r) => n + (r.questions?.length ?? 0), 0),
    questionsAnswered: ready.reduce((n, r) => n + (r.questions?.filter((q) => q.answer).length ?? 0), 0),
    factsLearned: ready.reduce((n, r) => n + (r.learned?.length ?? 0), 0),
    pagesKept: ready.filter((r) => r.engine.pagesAfter !== null && r.engine.pagesAfter === r.engine.pagesBefore).length,
    meanSeconds: mean(ready.map((r) => r.engine.seconds)),
    meanCalls: mean(ready.map((r) => r.engine.calls)),
  };
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–");
const fix = (n: number | null, digits = 1) => (n === null ? "–" : n.toFixed(digits));
const signed = (n: number | null, digits = 2) => (n === null ? "–" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`);

export function markdownReport(results: CaseResult[], meta: { engine: string; judge: string; startedAt: string }): string {
  const s = summarize(results);
  const lines = [
    `# Tailoring evaluation`,
    ``,
    `Engine: ${meta.engine} · Judge: ${meta.judge} · Started ${meta.startedAt}`,
    ``,
    `Each case tailors a resume for a real job posting. A recruiter judge then screens the original and the`,
    `tailored version separately, each in a fresh context, and decides whether to advance it to a phone screen.`,
    `A truthfulness audit compares the tailored text with the original.`,
    ``,
    `## Summary`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Cases | ${s.cases} (${s.ready} tailored, ${s.failed} failed) |`,
    `| Advanced to a phone screen: original → tailored | ${s.originalAdvanced} → ${s.tailoredAdvanced} of ${s.screened} (${pct(s.originalAdvanced, s.screened)} → ${pct(s.tailoredAdvanced, s.screened)}) |`,
    `| Gained (not advanced → advanced) / lost | ${s.gained} / ${s.lost} |`,
    `| Mean fit change (1–10) | ${signed(s.meanFitDelta)} |`,
    `| Must-haves the recruiter saw (mean) | ${fix(s.meanShownBefore)} → ${fix(s.meanShownAfter)} |`,
    `| Truthfulness: no high/medium issue | ${s.audit.clean} of ${s.audit.audited} (${pct(s.audit.clean, s.audit.audited)}) |`,
    `| Truthfulness issues (high / medium / low) | ${s.audit.high} / ${s.audit.medium} / ${s.audit.low} |`,
    ...(s.questionsAsked ? [`| Gap questions: asked / answered from the candidate's history / facts learned | ${s.questionsAsked} / ${s.questionsAnswered} / ${s.factsLearned} |`] : []),
    `| Page count kept | ${s.pagesKept} of ${s.ready} |`,
    `| Mean time / model calls per case | ${fix(s.meanSeconds, 0)} s / ${fix(s.meanCalls)} |`,
    ``,
    `## Cases`,
    ``,
    `| Case | Level | Fit | Advanced (orig → tailored) | Fit | Must-haves seen | Audit (H/M/L) | Edits (dropped) | Pages | Time |`,
    `|---|---|---|---|---|---|---|---|---|---|`,
  ];
  for (const r of results) {
    const sc = r.screen;
    const a = r.audit?.issues ?? [];
    const sev = (v: string) => a.filter((i) => i.severity === v).length;
    const e = r.engine;
    const yn = (b: boolean) => (b ? "yes" : "no");
    lines.push(
      `| ${r.resume} → ${r.posting.company}: ${r.posting.role} | ${r.posting.level ?? ""} | ${r.fit ? `${r.fit.level} (${r.fit.must.strong}/${r.fit.must.total})` : "–"} | ${r.status !== "ready" ? r.status : sc ? `${yn(sc.original.advance)} → ${yn(sc.tailored.advance)}` : "–"} | ${sc ? `${sc.original.fit} → ${sc.tailored.fit}` : "–"} | ${sc ? `${sc.original.shown.length} → ${sc.tailored.shown.length}` : "–"} | ${r.audit ? `${sev("high")}/${sev("medium")}/${sev("low")}` : "–"} | ${e?.edits ?? "–"} (${e?.dropped ?? "–"}) | ${e?.pagesBefore ?? "–"}→${e?.pagesAfter ?? "–"} | ${e?.seconds ?? "–"}s |`,
    );
  }
  const flips = results.filter((r) => r.screen && r.screen.original.advance !== r.screen.tailored.advance);
  if (flips.length) {
    lines.push(``, `## Decisions that changed`, ``);
    for (const r of flips) lines.push(`- **${r.id}** (${r.screen!.tailored.advance ? "gained" : "lost"}): original: ${r.screen!.original.reason} Tailored: ${r.screen!.tailored.reason}`);
  }
  // Does the engine's fit call (made before any rewriting) predict the recruiter's decision?
  const called = results.filter((r) => r.fit && r.screen);
  if (called.length) {
    lines.push(``, `## The engine's fit call vs the recruiter`, ``, `| Fit (before tailoring) | Cases | Original advanced | Tailored advanced |`, `|---|---|---|---|`);
    for (const level of ["strong", "stretch", "long-shot"] as const) {
      const rs = called.filter((r) => r.fit!.level === level);
      if (!rs.length) continue;
      lines.push(`| ${level} | ${rs.length} | ${rs.filter((r) => r.screen!.original.advance).length} | ${rs.filter((r) => r.screen!.tailored.advance).length} |`);
    }
  }
  const asked = results.filter((r) => r.questions?.length);
  if (asked.length) {
    lines.push(``, `## Gap questions and the candidate's answers`, ``);
    for (const r of asked) {
      lines.push(`**${r.id}**`, ``);
      for (const q of r.questions!) lines.push(`- ${q.question} → ${q.answer ?? "_I haven't done this._"}`);
      lines.push(``);
    }
  }
  const flagged = results.flatMap((r) => (r.audit?.issues ?? []).filter((i) => i.severity !== "low").map((i) => ({ r, i })));
  if (flagged.length) {
    lines.push(``, `## Truthfulness issues (high and medium)`, ``);
    for (const { r, i } of flagged) lines.push(`- **${i.severity} · ${i.kind}** (${r.id}): "${i.quote}" ${i.why}`);
  }
  const failed = results.filter((r) => r.status !== "ready");
  if (failed.length) {
    lines.push(``, `## Failed cases`, ``);
    for (const r of failed) lines.push(`- ${r.id}: ${r.error ?? r.status}`);
  }
  return lines.join("\n") + "\n";
}
