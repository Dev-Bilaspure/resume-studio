// How well the candidate fits the job, before any rewriting: from the engine's own requirement matching,
// at no extra model cost. Tailoring makes real experience visible; it can't create it. So this tells you
// where an application can win, and where no wording will close the gap.
import type { JobProfile, RequirementMatch } from "./types.ts";

export type FitLevel = "strong" | "stretch" | "long-shot";

export interface FitAssessment {
  level: FitLevel;
  /** Must-have requirements: clearly shown, partly shown, not shown. */
  must: { strong: number; weak: number; missing: number; total: number };
  /** Must-haves the resume doesn't show at all, as written in the posting. */
  gaps: string[];
  /** A missing must-have about years of experience or a degree: hard to argue past. */
  hardGap: boolean;
}

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
