// Aggregates case results into the numbers that answer "does tailoring help, and is it honest?".
import type { CaseResult } from "./run.ts";

export interface Summary {
  cases: number;
  ready: number;
  failed: number;
  /** Blind screens (two per case) where the tailored resume was the one advanced. */
  screens: number;
  tailoredAdvanced: number;
  /** Cases where both orders agreed on the tailored resume / on the original / split by position. */
  tailoredWonBoth: number;
  originalWonBoth: number;
  splitByPosition: number;
  /** Mean of (tailored fit − original fit), 1–10 scale, across all screens. */
  meanFitDelta: number | null;
  audit: { audited: number; clean: number; high: number; medium: number; low: number; byKind: Record<string, number> };
  pagesKept: number;
  meanSeconds: number | null;
  meanCalls: number | null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function summarize(results: CaseResult[]): Summary {
  const ready = results.filter((r) => r.status === "ready");
  const screens = ready.flatMap((r) => r.screens ?? []);
  const advanced = screens.filter((s) => s.result.advance === s.tailoredAs).length;
  let both = 0;
  let neither = 0;
  let split = 0;
  for (const r of ready) {
    if (!r.screens || r.screens.length < 2) continue;
    const wins = r.screens.filter((s) => s.result.advance === s.tailoredAs).length;
    if (wins === 2) both++;
    else if (wins === 0) neither++;
    else split++;
  }
  const deltas = screens.map((s) => (s.tailoredAs === "A" ? s.result.fitA - s.result.fitB : s.result.fitB - s.result.fitA));
  const audited = ready.filter((r) => r.audit);
  const issues = audited.flatMap((r) => r.audit!.issues);
  const byKind: Record<string, number> = {};
  for (const i of issues) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
  return {
    cases: results.length,
    ready: ready.length,
    failed: results.length - ready.length,
    screens: screens.length,
    tailoredAdvanced: advanced,
    tailoredWonBoth: both,
    originalWonBoth: neither,
    splitByPosition: split,
    meanFitDelta: mean(deltas),
    audit: {
      audited: audited.length,
      clean: audited.filter((r) => !r.audit!.issues.some((i) => i.severity !== "low")).length,
      high: issues.filter((i) => i.severity === "high").length,
      medium: issues.filter((i) => i.severity === "medium").length,
      low: issues.filter((i) => i.severity === "low").length,
      byKind,
    },
    pagesKept: ready.filter((r) => r.engine.pagesAfter !== null && r.engine.pagesAfter === r.engine.pagesBefore).length,
    meanSeconds: mean(ready.map((r) => r.engine.seconds)),
    meanCalls: mean(ready.map((r) => r.engine.calls)),
  };
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–");
const fix = (n: number | null, digits = 1) => (n === null ? "–" : n.toFixed(digits));

export function markdownReport(results: CaseResult[], meta: { engine: string; judge: string; startedAt: string }): string {
  const s = summarize(results);
  const lines = [
    `# Tailoring evaluation`,
    ``,
    `Engine: ${meta.engine} · Judge: ${meta.judge} · Started ${meta.startedAt}`,
    ``,
    `## Summary`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Cases | ${s.cases} (${s.ready} tailored, ${s.failed} failed) |`,
    `| Blind screen: tailored advanced | ${s.tailoredAdvanced} of ${s.screens} screens (${pct(s.tailoredAdvanced, s.screens)}) |`,
    `| …in both orders / original in both / split by position | ${s.tailoredWonBoth} / ${s.originalWonBoth} / ${s.splitByPosition} |`,
    `| Mean fit change (1–10 scale) | ${s.meanFitDelta === null ? "–" : `${s.meanFitDelta >= 0 ? "+" : ""}${s.meanFitDelta.toFixed(2)}`} |`,
    `| Truthfulness: resumes with no high/medium issue | ${s.audit.clean} of ${s.audit.audited} (${pct(s.audit.clean, s.audit.audited)}) |`,
    `| Truthfulness issues (high / medium / low) | ${s.audit.high} / ${s.audit.medium} / ${s.audit.low} |`,
    `| Page count kept | ${s.pagesKept} of ${s.ready} |`,
    `| Mean time / model calls per case | ${fix(s.meanSeconds, 0)} s / ${fix(s.meanCalls)} |`,
    ``,
    `## Cases`,
    ``,
    `| Case | Level | Status | Advanced (B, A) | Fit Δ | Audit (H/M/L) | Edits (dropped) | Keywords* | Strong reqs* | Pages | Time |`,
    `|---|---|---|---|---|---|---|---|---|---|---|`,
  ];
  for (const r of results) {
    const scr = r.screens ?? [];
    const adv = scr.map((x) => (x.result.advance === x.tailoredAs ? "T" : "O")).join(", ") || "–";
    const d = scr.length ? mean(scr.map((x) => (x.tailoredAs === "A" ? x.result.fitA - x.result.fitB : x.result.fitB - x.result.fitA))) : null;
    const a = r.audit?.issues ?? [];
    const sev = (v: string) => a.filter((i) => i.severity === v).length;
    const e = r.engine;
    lines.push(
      `| ${r.resume} → ${r.posting.company}: ${r.posting.role} | ${r.posting.level ?? ""} | ${r.status} | ${adv} | ${d === null ? "–" : (d >= 0 ? "+" : "") + d.toFixed(1)} | ${r.audit ? `${sev("high")}/${sev("medium")}/${sev("low")}` : "–"} | ${e.edits} (${e.dropped}) | ${e.keywordsBefore}→${e.keywordsAfter}/${e.keywordsTotal} | ${e.strongBefore}→${e.strongAfter}/${e.requirements} | ${e.pagesBefore ?? "–"}→${e.pagesAfter ?? "–"} | ${e.seconds}s |`,
    );
  }
  lines.push(``, `T = the tailored resume was advanced, O = the original. *The engine's own measures, from its reading of the posting.`);
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
