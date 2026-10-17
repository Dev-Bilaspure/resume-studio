// Runs one case: tailor the resume for the posting with the real engine, then audit and screen the result.
import { LLMError, type LLM } from "@resume-studio/llm";
import { assessFit, createTailorEngine, jobCompany, jobTitle, memoryFactStore, memorySessionStore, type FitAssessment, type Session } from "@resume-studio/tailor";
import { latexAdapter } from "@resume-studio/tailor-latex";
import { latexmkVerifier } from "@resume-studio/tailor-latex/node";
import { jobInput, type Case } from "./data.ts";
import { answerAsCandidate, auditTruthfulness, screenOne, type Audit, type Screen } from "./judges.ts";

export interface CaseResult {
  id: string;
  resume: string;
  jd: string;
  posting: { company: string; role: string; level?: string; family?: string };
  status: Session["status"];
  error?: string;
  engine: {
    provider: string;
    model: string;
    seconds: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    edits: number;
    dropped: number;
    flagged: number;
    pagesBefore: number | null;
    pagesAfter: number | null;
    atsBefore: number | null;
    atsAfter: number | null;
    /** The engine's own measures (its reading of the posting), for reference: */
    keywordsBefore: number;
    keywordsAfter: number;
    keywordsTotal: number;
    strongBefore: number;
    strongAfter: number;
    requirements: number;
  };
  /** The engine's fit call before rewriting (from its requirement matching), to check against the recruiter. */
  fit?: FitAssessment;
  /** The engine's gap questions and the simulated candidate's answers (null: "I haven't done this"). */
  questions?: { id: string; topic: string; question: string; answer: string | null }[];
  /** Facts the engine learned from those answers. */
  learned?: string[];
  /** What the engine did, kept so a result can be explained: its plan, every edit, and both texts. */
  strategy?: string;
  edits?: { id: string; op: string; target: string; before: string | null; after: string | null; reason: string; status?: string; issues?: string[] }[];
  texts?: { original: string; tailored: string };
  audit?: Audit;
  /** Each version screened on its own, in a fresh context: would a recruiter advance it? */
  screen?: { original: Screen; tailored: Screen };
  judge: { provider: string; model: string };
  finishedAt: string;
}

export interface RunDeps {
  engineLLM: LLM;
  judgeLLM: LLM;
  signal?: AbortSignal;
  onStep?(message: string): void;
  /** Let the engine ask its gap questions, answered by a simulated candidate from the resume's history.md. */
  questions?: boolean;
}

/** True when the run should stop (a usage limit), as opposed to a failure of this one case. */
export const isStopError = (e: unknown) => e instanceof LLMError && (e.kind === "rate_limit" || e.kind === "auth" || e.kind === "aborted");

export async function runCase(c: Case, deps: RunDeps): Promise<CaseResult> {
  const started = Date.now();
  const engine = createTailorEngine({
    llm: deps.engineLLM,
    adapter: latexAdapter,
    verifier: latexmkVerifier({ assetsDir: c.resume.dir }),
    store: memorySessionStore(),
    facts: memoryFactStore(),
    onEvent: (_id, e) => e.type === "step" && deps.onStep?.(e.message),
  });
  const ask = !!deps.questions && !!c.resume.history;
  let s = await engine.start({ job: jobInput(c.posting), source: c.resume.source, options: { askQuestions: ask } });
  s = await engine.run(s.id, deps.signal);
  let asked: CaseResult["questions"];
  if (s.status === "needs_input") {
    const qs = s.questions ?? [];
    deps.onStep?.(`The candidate answers ${qs.length} question${qs.length === 1 ? "" : "s"}`);
    const given = await answerAsCandidate(deps.judgeLLM, c.resume.history!, qs, deps.signal);
    const byId = new Map(given.map((a) => [a.questionId, a.answer?.trim() || null]));
    asked = qs.map((q) => ({ id: q.id, topic: q.topic, question: q.question, answer: byId.get(q.id) ?? null }));
    await engine.answer(s.id, asked.map((q) => (q.answer ? { questionId: q.id, text: q.answer } : { questionId: q.id, none: true })));
    s = await engine.run(s.id, deps.signal);
  }
  // A stop (usage limit) mid-case: surface it so the whole run pauses instead of recording a failure.
  if (s.status === "failed" && s.error?.kind && ["rate_limit", "auth", "aborted"].includes(s.error.kind)) {
    throw new LLMError(s.error.kind as "rate_limit", s.error.message, false, deps.engineLLM.provider);
  }

  const r = s.report;
  const edits = s.edits ?? [];
  const result: CaseResult = {
    id: c.id,
    resume: c.resume.id,
    jd: c.posting.id,
    // As the engine read them (a raw posting has no front matter).
    posting: { company: jobCompany(s.job), role: jobTitle(s.job), level: c.posting.level ?? s.job.seniority ?? s.profile?.seniority, family: c.posting.family ?? s.profile?.roleFamily },
    status: s.status,
    error: s.error?.message,
    engine: {
      provider: s.provenance.provider,
      model: s.provenance.model,
      seconds: Math.round((Date.now() - started) / 1000),
      calls: s.usage.calls,
      inputTokens: s.usage.inputTokens,
      outputTokens: s.usage.outputTokens,
      edits: edits.filter((e) => e.status !== "dropped").length,
      dropped: edits.filter((e) => e.status === "dropped").length,
      flagged: edits.filter((e) => e.status === "flagged").length,
      pagesBefore: r?.before.build?.pages ?? null,
      pagesAfter: r?.after.build?.pages ?? null,
      atsBefore: r?.before.build?.atsScore ?? null,
      atsAfter: r?.after.build?.atsScore ?? null,
      keywordsBefore: r?.before.keywordsFound.length ?? 0,
      keywordsAfter: r?.after.keywordsFound.length ?? 0,
      keywordsTotal: r ? r.before.keywordsFound.length + r.before.keywordsMissing.length : 0,
      strongBefore: r?.before.requirementsStrong ?? 0,
      strongAfter: r?.after.requirementsStrong ?? 0,
      requirements: r?.before.requirementsTotal ?? 0,
    },
    judge: { provider: deps.judgeLLM.provider, model: deps.judgeLLM.model },
    finishedAt: "",
  };

  const before = r?.before.build?.text;
  const after = r?.after.build?.text;
  if (s.profile && s.matches) result.fit = assessFit(s.profile, s.matches);
  result.questions = asked;
  result.learned = s.newFacts.map((f) => f.text);
  result.strategy = s.strategy;
  result.edits = edits.map((e) => ({
    id: e.id,
    op: e.change.op,
    target: e.change.target,
    before: originalText(s, e.change.target),
    after: "text" in e.change ? e.change.text : e.change.op === "reorder_bullets" ? e.change.order.join(", ") : null,
    reason: e.reason,
    status: e.status,
    issues: e.issues,
  }));
  if (before && after) result.texts = { original: before, tailored: after };
  if (s.status === "ready" && before && after) {
    deps.onStep?.("Auditing truthfulness");
    // The candidate's own answers are legitimate sources, exactly as they said them.
    const confirmed = (asked ?? []).filter((q) => q.answer).map((q) => q.answer!);
    result.audit = await auditTruthfulness(deps.judgeLLM, before, after, deps.signal, confirmed);
    deps.onStep?.("Recruiter screen: original");
    const original = await screenOne(deps.judgeLLM, c.posting, before, deps.signal);
    deps.onStep?.("Recruiter screen: tailored");
    const tailored = await screenOne(deps.judgeLLM, c.posting, after, deps.signal);
    result.screen = { original, tailored };
  }
  result.finishedAt = new Date().toISOString();
  return result;
}

/** The text an edit's target had before (a bullet, the headline, a skills line, the summary). */
function originalText(s: Session, target: string): string | null {
  const doc = s.doc;
  if (!doc) return null;
  if (doc.headline?.id === target) return doc.headline.text;
  for (const sec of doc.sections) {
    if (sec.paragraph?.id === target) return sec.paragraph.text;
    for (const k of sec.skills) if (k.id === target) return `${k.label ? `${k.label}: ` : ""}${k.text}`;
    for (const l of sec.lists) {
      if (l.id === target) return l.heading;
      for (const b of l.bullets) if (b.id === target) return b.text;
    }
  }
  return null;
}
