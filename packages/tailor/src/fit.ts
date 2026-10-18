// How well the candidate fits the job, before any rewriting: from the engine's own requirement matching,
// at no extra model cost. Tailoring makes real experience visible; it can't create it. So this tells you
// where an application can win, and where no wording will close the gap.
import type { FitAssessment, FitLevel, JobProfile, RequirementMatch } from "./types.ts";

export type { FitAssessment, FitLevel };

/** Weak counts half: implied or adjacent evidence, which a recruiter may or may not credit. */
export function assessFit(profile: JobProfile, matches: RequirementMatch[]): FitAssessment {
  const status = new Map(matches.map((m) => [m.requirementId, m.status]));
  const must = profile.requirements.filter((r) => r.kind === "must");
  const count = (s: RequirementMatch["status"]) => must.filter((r) => status.get(r.id) === s).length;
  const strong = count("strong");
  const weak = count("weak");
  const missing = must.length - strong - weak;
  const gaps = must.filter((r) => (status.get(r.id) ?? "missing") === "missing");
  const hardGap = gaps.some((r) => r.category === "experience" || r.category === "education");
  const coverage = must.length ? (strong + weak / 2) / must.length : 1;
  const level: FitLevel = coverage >= 0.75 && !hardGap ? "strong" : coverage >= 0.45 ? "stretch" : "long-shot";
  return { level, must: { strong, weak, missing, total: must.length }, gaps: gaps.map((r) => r.text), hardGap };
}
