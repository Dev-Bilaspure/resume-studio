// Runs one case: tailor the resume for the posting with the real engine, then audit and screen the result.
import { LLMError, type LLM } from "@resume-studio/llm";
import { createTailorEngine, memoryFactStore, memorySessionStore, type Session } from "@resume-studio/tailor";
import { latexAdapter } from "@resume-studio/tailor-latex";
import { latexmkVerifier } from "@resume-studio/tailor-latex/node";
import { jobInput, type Case } from "./data.ts";
import { auditTruthfulness, screenPair, type Audit, type Screen } from "./judges.ts";

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
  audit?: Audit;
  /** The blind screen, run in both orders (position bias): tailored as B, then as A. */
  screens?: { tailoredAs: "A" | "B"; result: Screen }[];
  judge: { provider: string; model: string };
  finishedAt: string;
}

export interface RunDeps {
  engineLLM: LLM;
  judgeLLM: LLM;
  signal?: AbortSignal;
  onStep?(message: string): void;
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
  let s = await engine.start({ job: jobInput(c.posting), source: c.resume.source, options: { askQuestions: false } });
  s = await engine.run(s.id, deps.signal);
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
    posting: { company: c.posting.company, role: c.posting.role, level: c.posting.level, family: c.posting.family },
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
  if (s.status === "ready" && before && after) {
    deps.onStep?.("Auditing truthfulness");
    result.audit = await auditTruthfulness(deps.judgeLLM, before, after, deps.signal);
    deps.onStep?.("Blind recruiter screen (tailored as B)");
    const asB = await screenPair(deps.judgeLLM, c.posting, before, after, deps.signal);
    deps.onStep?.("Blind recruiter screen (tailored as A)");
    const asA = await screenPair(deps.judgeLLM, c.posting, after, before, deps.signal);
    result.screens = [
      { tailoredAs: "B", result: asB },
      { tailoredAs: "A", result: asA },
    ];
  }
  result.finishedAt = new Date().toISOString();
  return result;
}
