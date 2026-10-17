import { LLMError, type LLM } from "@resume-studio/llm";
import { EditApplyError, memorySessionStore, type BuildVerifier, type FactStore, type FormatAdapter, type SessionStore } from "./adapters.ts";
import { applyToDoc, docText, mergeFitEdits } from "./doc.ts";
import { canonical, variants } from "./lexicon.ts";
import {
  EditsSchema,
  FactsSchema,
  JobProfileSchema,
  JudgeSchema,
  MatchSchema,
  PROMPTS_VERSION,
  analyzePrompt,
  editsPrompt,
  factsPrompt,
  fitPrompt,
  judgePrompt,
  matchPrompt,
  repairPrompt,
  type EditOutput,
  PostingSchema,
  postingPrompt,
} from "./prompts.ts";
import { coverage, uid } from "./text.ts";
import type { Answer, BuildCheck, Edit, Fact, JobInput, JobProfile, Report, Session, SessionStatus, SourceFiles, TailorEvent, TailorOptions } from "./types.ts";
import { beforeText, checkEdits, entryHeading, evidenceText, indexDoc, toEdit } from "./verify.ts";

export const ENGINE_VERSION = "0.1.0";
const MAX_QUESTIONS = 6;
const MAX_FIT_ROUNDS = 2;

export interface EngineDeps {
  llm: LLM;
  adapter: FormatAdapter;
  verifier?: BuildVerifier;
  store?: SessionStore;
  facts?: FactStore;
  onEvent?(sessionId: string, event: TailorEvent, session: Session): void;
}

export interface StartInput {
  job: JobInput;
  source: SourceFiles;
  options?: TailorOptions;
  /** Facts to use in addition to the fact store's (e.g. from a client that keeps its own). */
  facts?: Fact[];
  /** Stored on the session for the client (resume id, user id…). */
  context?: Record<string, string>;
}

export class SessionError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createTailorEngine(deps: EngineDeps) {
  const store = deps.store ?? memorySessionStore();

  async function load(id: string): Promise<Session> {
    const s = await store.get(id);
    if (!s) throw new SessionError(404, `No session ${id}`);
    return s;
  }

  function event(s: Session, e: Omit<TailorEvent, "at">) {
    const ev = { ...e, at: new Date().toISOString() };
    s.events.push(ev);
    deps.onEvent?.(s.id, ev, s);
  }

  async function save(s: Session, status?: SessionStatus) {
    if (status && status !== s.status) {
      s.status = status;
      event(s, { type: "status", status, message: status });
    }
    s.updatedAt = new Date().toISOString();
    await store.put(s);
  }

  /** llm.generate with usage accounting per step. */
  async function call<T>(s: Session, step: string, req: Parameters<LLM["generate"]>[0] & { schema: import("zod").ZodType<T> }, signal?: AbortSignal) {
    event(s, { type: "step", step, message: stepLabel(step) });
    const res = await deps.llm.generate<T>({ ...req, step, signal });
    // What actually answered ("claude-opus-5-5" for "opus"): the record shows the real model.
    s.provenance.model = res.model;
    const u = (s.usage.byStep[step] ??= { calls: 0, inputTokens: 0, outputTokens: 0, ms: 0 });
    u.calls++;
    u.inputTokens += res.usage.inputTokens;
    u.outputTokens += res.usage.outputTokens;
    u.ms += res.durationMs;
    s.usage.calls++;
    s.usage.inputTokens += res.usage.inputTokens;
    s.usage.outputTokens += res.usage.outputTokens;
    return res.data;
  }

  // ---- Steps -----------------------------------------------------------------------------------------------

  async function analyze(s: Session, signal?: AbortSignal) {
    // No company or title given (a pasted posting): take them, and the level and location, from the posting.
    if ((!s.job.company || !s.job.role) && !s.context._postingRead) {
      const d = await call(s, "read-posting", { ...postingPrompt(s.job.description), schema: PostingSchema, schemaName: "posting_details", maxOutputTokens: 1_000 }, signal);
      s.job = {
        ...s.job,
        company: s.job.company || d.company?.trim() || "",
        role: s.job.role || d.role?.trim() || d.suggestedRole?.trim() || "",
        seniority: s.job.seniority ?? d.seniority ?? undefined,
        location: s.job.location || d.location?.trim() || undefined,
      };
      s.context._postingRead = "1";
    }
    const out = await call(s, "analyze-job", { ...analyzePrompt(s.job), schema: JobProfileSchema, schemaName: "job_profile" }, signal);
    // Canonical spellings, aliases from the lexicon too, de-duplicated.
    const keywords = new Map<string, JobProfile["keywords"][number]>();
    for (const k of out.keywords) {
      const term = k.term.trim();
      if (!term) continue;
      const key = canonical(term).toLowerCase();
      const prev = keywords.get(key);
      const aliases = [...new Set([...(prev?.aliases ?? []), ...k.aliases, ...variants(term)].filter((a) => a && a.toLowerCase() !== term.toLowerCase()))];
      keywords.set(key, { term, aliases, importance: prev?.importance === "must" || k.importance === "must" ? "must" : "nice", kind: prev?.kind === "term" || k.kind === "term" ? "term" : "concept" });
    }
    s.profile = {
      roleFamily: out.roleFamily,
      seniority: s.job.seniority ?? out.seniority,
      summary: out.summary,
      requirements: out.requirements.map((r, i) => ({ ...r, id: `r${i + 1}` })),
      keywords: [...keywords.values()],
      responsibilities: out.responsibilities,
      dealBreakers: out.dealBreakers,
    };
  }

  async function match(s: Session, signal?: AbortSignal) {
    const out = await call(s, "match-evidence", { ...matchPrompt(s.doc!, s.facts, s.profile!, s.options), schema: MatchSchema, schemaName: "requirement_matches" }, signal);
    const ids = new Set(s.profile!.requirements.map((r) => r.id));
    const byReq = new Map(out.matches.filter((m) => ids.has(m.requirementId)).map((m) => [m.requirementId, m]));
    // Every requirement gets a verdict, even if the model skipped one.
    s.matches = s.profile!.requirements.map((r) => byReq.get(r.id) ?? { requirementId: r.id, status: "missing" as const, evidence: [], note: "Not assessed." });
    s.questions =
      s.options.askQuestions === false
        ? []
        : out.questions
            .filter((q) => ids.has(q.requirementId))
            .slice(0, MAX_QUESTIONS)
            .map((q, i) => ({ ...q, id: `q${i + 1}` }));
  }

  async function learnFacts(s: Session, signal?: AbortSignal) {
    const answered = (s.answers ?? []).filter((a) => !a.none && a.text?.trim());
    if (!answered.length) return;
    const out = await call(s, "learn-facts", { ...factsPrompt(s.questions ?? [], answered), schema: FactsSchema, schemaName: "facts" }, signal);
    const now = new Date().toISOString();
    const learned: Fact[] = out.facts
      .filter((f) => f.text.trim())
      .map((f) => ({ id: uid("f"), text: f.text.trim(), skills: f.skills.map((x) => canonical(x)), source: "answer", createdAt: now }));
    s.newFacts = learned;
    s.facts = [...s.facts, ...learned];
    await deps.facts?.add(learned);
    // The answered requirements now have evidence.
    for (const f of learned) {
      const q = s.questions?.find((x) => out.facts.find((o) => o.text.trim() === f.text)?.questionId === x.id);
      const m = q && s.matches?.find((x) => x.requirementId === q.requirementId);
      if (m) {
        m.status = "strong";
        m.evidence = [...m.evidence, { kind: "fact", id: f.id }];
        m.note = "From your answer.";
      }
    }
  }

  async function writeEdits(s: Session, before: BuildCheck | undefined, signal?: AbortSignal) {
    const out = await call(
      s,
      "write-edits",
      {
        ...editsPrompt({ doc: s.doc!, facts: s.facts, job: s.job, profile: s.profile!, matches: s.matches!, opts: s.options, currentPages: before?.pages ?? null }),
        schema: EditsSchema,
        schemaName: "resume_edits",
        maxOutputTokens: 32_000,
      },
      signal,
    );
    s.strategy = out.strategy;
    const { edits, rejected } = convert(out.edits, 1);
    for (const r of rejected) event(s, { type: "warning", message: `Skipped an edit: ${r}` });
    return edits;
  }

  /** Deterministic checks → model fact-check → one repair round → final verdicts. */
  async function verifyEdits(s: Session, edits: Edit[], signal?: AbortSignal): Promise<Edit[]> {
    const ix = indexDoc(s.doc!, s.facts);
    const first = checkEdits(edits, ix, s.profile!, s.options);
    // Structural problems (a duplicate or unknown target) can't be fixed by rewording: drop them.
    // Content problems (numbers, technologies, markup, the fact-check) get one repair round.
    const structural = (issues: string[]) => issues.every((i) => /another edit already changes|unknown (bullet|entry|paragraph|skills line|headline)|isn't in entry|every bullet of the entry|isn't allowed/.test(i));
    const dropped: Edit[] = first.failed.filter((f) => structural(f.issues)).map((f) => ({ ...f.edit, status: "dropped", issues: f.issues }));
    let failed = first.failed.filter((f) => !structural(f.issues));
    const judged = await judge(s, first.passed, ix, signal);
    let passed = judged.passed;
    failed = [...failed, ...judged.failed];

    if (failed.length) {
      event(s, { type: "step", step: "repair", message: `Fixing ${failed.length} edit${failed.length === 1 ? "" : "s"} that overstated the evidence` });
      const out = await call(s, "repair", { ...repairPrompt({ doc: s.doc!, facts: s.facts, problems: failed }), schema: EditsSchema, schemaName: "resume_edits" }, signal);
      const { edits: fixed } = convert(out.edits, edits.length + 1);
      // A fix must be for a target that failed, and pass every check again.
      const byTarget = new Map(failed.map((f) => [f.edit.change.target, f]));
      const candidates = fixed.filter((e) => byTarget.has(e.change.target));
      const recheck = checkEdits([...passed, ...candidates], ix, s.profile!, s.options);
      const rejudged = await judge(s, recheck.passed.filter((e) => candidates.some((c) => c.id === e.id)), ix, signal);
      for (const e of rejudged.passed) {
        const original = byTarget.get(e.change.target)!;
        byTarget.delete(e.change.target);
        // The fix replaces the original, with its own reason (the original's may describe what was cut,
        // like a skill the evidence didn't support); the note says what was wrong with the first version.
        passed.push({ ...e, reason: e.reason || original.edit.reason, issues: [`Revised after the fact-check: ${original.issues.join("; ")}`, ...(e.issues ?? [])] });
      }
      for (const f of byTarget.values()) dropped.push({ ...f.edit, status: "dropped", issues: f.issues });
    }
    return order([...passed, ...dropped]);
  }

  async function judge(s: Session, edits: Edit[], ix: ReturnType<typeof indexDoc>, signal?: AbortSignal) {
    const textual = edits.filter((e) => "text" in e.change && e.change.op !== "rewrite_skills");
    if (!textual.length) return { passed: edits, failed: [] as { edit: Edit; issues: string[] }[] };
    const items = textual.map((e) => ({
      id: e.id,
      before: beforeText(ix, e.change),
      after: "text" in e.change ? e.change.text : "",
      evidence: [entryHeading(ix, e.change), ...e.evidence.map((r) => evidenceText(ix, r))].filter((x): x is string => !!x),
    }));
    const out = await call(s, "fact-check", { ...judgePrompt(items), schema: JudgeSchema, schemaName: "fact_check" }, signal);
    const verdict = new Map(out.verdicts.map((v) => [v.editId, v]));
    const passed: Edit[] = [];
    const failed: { edit: Edit; issues: string[] }[] = [];
    for (const e of edits) {
      const v = verdict.get(e.id);
      if (v && v.verdict !== "supported") failed.push({ edit: e, issues: v.problems.length ? v.problems : [`${v.verdict} by the fact-check`] });
      else passed.push(e);
    }
    return { passed, failed };
  }

  /** Applies ok/flagged edits; an edit the adapter can't apply is dropped and the rest retried. */
  async function applyAll(s: Session, edits: Edit[]): Promise<SourceFiles> {
    let usable = edits.filter((e) => e.status !== "dropped");
    for (let attempt = 0; attempt < usable.length + 1; attempt++) {
      try {
        return await deps.adapter.apply(s.source, s.doc!, usable);
      } catch (e) {
        if (!(e instanceof EditApplyError)) throw e;
        const bad = edits.find((x) => x.id === e.editId);
        if (!bad) throw e;
        bad.status = "dropped";
        bad.issues = [...(bad.issues ?? []), `couldn't be applied: ${e.message}`];
        usable = usable.filter((x) => x.id !== e.editId);
      }
    }
    return s.source;
  }

  async function build(s: Session, source: SourceFiles, maxPages: number | undefined, signal?: AbortSignal) {
    if (!deps.verifier) return undefined;
    event(s, { type: "step", step: "build", message: "Compiling the draft" });
    return deps.verifier.build(source, { maxPages, signal });
  }

  /** Builds the draft; drops edits that break the build; cuts to the page budget. */
  async function fitAndBuild(s: Session, edits: Edit[], before: BuildCheck | undefined, signal?: AbortSignal) {
    const maxPages = s.options.maxPages ?? before?.pages ?? undefined;
    let draft = await applyAll(s, edits);
    let check = await build(s, draft, maxPages, signal);

    // Build errors the original didn't have come from an edit: drop it (once per error).
    for (let i = 0; check && !check.ok && i < 3; i++) {
      const culprit = check.errors.map((er) => deps.verifier?.editAt?.(draft, er)).find((x): x is string => !!x);
      const bad = culprit ? edits.find((e) => e.id === culprit) : undefined;
      if (!bad) break;
      bad.status = "dropped";
      bad.issues = [...(bad.issues ?? []), "broke the build"];
      draft = await applyAll(s, edits);
      check = await build(s, draft, maxPages, signal);
    }

    for (let round = 0; check && maxPages && check.pages && check.pages > maxPages && round < MAX_FIT_ROUNDS; round++) {
      const virtual = applyToDoc(s.doc!, edits.filter((e) => e.status !== "dropped"));
      const out = await call(
        s,
        "fit-pages",
        { ...fitPrompt({ doc: virtual, job: s.job, profile: s.profile!, overflowLines: check.overflowLines ?? 3, maxPages }), schema: EditsSchema, schemaName: "resume_edits" },
        signal,
      );
      const { edits: cuts } = convert(out.edits, edits.length + 1);
      const ix = indexDoc(virtual, s.facts);
      const { passed } = checkEdits(cuts, ix, s.profile!, s.options);
      if (!passed.length) break;
      edits = mergeFitEdits(edits, passed, s.doc!);
      draft = await applyAll(s, edits);
      check = await build(s, draft, maxPages, signal);
    }
    if (check && maxPages && check.pages && check.pages > maxPages) {
      event(s, { type: "warning", message: `The draft is ${check.pages} pages, over the ${maxPages}-page budget. Reject a few additions in review to bring it back.` });
    }
    return { edits: order(edits), draft, check };
  }

  function report(s: Session, edits: Edit[], before: BuildCheck | undefined, after: BuildCheck | undefined): Report {
    const profile = s.profile!;
    const kept = edits.filter((e) => e.status !== "dropped");
    const virtual = applyToDoc(s.doc!, kept);
    // After: requirements an edit addressed with evidence count as covered; others keep their status.
    const addressed = new Set(kept.flatMap((e) => e.requirements));
    const afterMatches = s.matches!.map((m) =>
      m.status !== "strong" && addressed.has(m.requirementId) && kept.some((e) => e.requirements.includes(m.requirementId) && e.evidence.length)
        ? { ...m, status: m.status === "missing" ? ("weak" as const) : ("strong" as const) }
        : m,
    );
    const warnings: string[] = [];
    // Hard filters the resume can't change. Years/degree ones you already meet (a strong experience or
    // education requirement) aren't worth a warning.
    const met = (kind: string) =>
      afterMatches.some((m) => m.status === "strong" && profile.requirements.find((r) => r.id === m.requirementId)?.category === (kind === "years" ? "experience" : "education"));
    for (const d of profile.dealBreakers) if (!((d.kind === "years" || d.kind === "degree") && met(d.kind))) warnings.push(`Check: ${d.text}`);
    const dropped = edits.filter((e) => e.status === "dropped").length;
    if (dropped) warnings.push(`${dropped} proposed edit${dropped === 1 ? " was" : "s were"} dropped because the evidence didn't support ${dropped === 1 ? "it" : "them"}.`);
    return {
      before: { ...coverage(before?.text ?? docText(s.doc!), profile.keywords, s.matches!), build: before },
      after: { ...coverage(after?.text ?? virtual.plainText, profile.keywords, afterMatches), build: after },
      strategy: s.strategy ?? "",
      warnings,
    };
  }

  // ---- Public API ------------------------------------------------------------------------------------------

  return {
    async start(input: StartInput): Promise<Session> {
      if (!input.job.description?.trim()) throw new SessionError(400, "The job description is empty");
      // Company and title are optional: real postings often leave one out (the engine reads the role from the text).
      input = { ...input, job: { ...input.job, company: input.job.company?.trim() ?? "", role: input.job.role?.trim() ?? "" } };
      const facts = [...((await deps.facts?.list()) ?? []), ...(input.facts ?? [])];
      const now = new Date().toISOString();
      const s: Session = {
        id: uid("ts"),
        version: 1,
        status: "created",
        createdAt: now,
        updatedAt: now,
        job: input.job,
        options: { allowHeadline: true, allowNewSkills: true, askQuestions: true, ...input.options },
        source: input.source,
        facts,
        newFacts: [],
        events: [],
        usage: { calls: 0, inputTokens: 0, outputTokens: 0, byStep: {} },
        provenance: { engine: ENGINE_VERSION, prompts: PROMPTS_VERSION, provider: deps.llm.provider, model: deps.llm.model },
        context: input.context ?? {},
      };
      await save(s);
      return s;
    },

    get: load,

    /**
     * Advances the session as far as it can: to `needs_input` (questions to answer) or `ready` (a draft
     * to review). Safe to call again after a failure: finished steps are kept.
     */
    async run(id: string, signal?: AbortSignal): Promise<Session> {
      const s = await load(id);
      if (s.status === "ready" || s.status === "cancelled") return s;
      if (s.status === "needs_input" && !s.answers) return s;
      try {
        await save(s, "analyzing");
        if (!s.doc) s.doc = await deps.adapter.parse(s.source);
        const beforeCheck = s.report?.before.build ?? (await build(s, s.source, undefined, signal));
        if (!s.profile) {
          await analyze(s, signal);
          await save(s);
        }
        if (!s.matches) {
          await match(s, signal);
          await save(s);
        }
        if (s.questions?.length && !s.answers) {
          s.report = { before: { ...coverage(beforeCheck?.text ?? docText(s.doc), s.profile!.keywords, s.matches!), build: beforeCheck }, after: { ...coverage("", [], []) }, strategy: "", warnings: [] };
          await save(s, "needs_input");
          return s;
        }
        await save(s, "writing");
        if (s.answers && !s.newFacts.length) await learnFacts(s, signal);
        let edits = await writeEdits(s, beforeCheck, signal);
        await save(s, "verifying");
        edits = await verifyEdits(s, edits, signal);
        const built = await fitAndBuild(s, edits, beforeCheck, signal);
        s.edits = built.edits;
        s.draft = built.draft;
        s.report = report(s, built.edits, beforeCheck, built.check);
        await save(s, "ready");
        return s;
      } catch (e) {
        const err = e as Error;
        if (signal?.aborted || (e instanceof LLMError && e.kind === "aborted")) {
          s.error = { message: "Cancelled" };
          await save(s, "cancelled");
          return s;
        }
        s.error = { message: err.message, kind: e instanceof LLMError ? e.kind : undefined, retryable: e instanceof LLMError ? e.retryable : true };
        event(s, { type: "error", message: err.message });
        await save(s, "failed");
        return s;
      }
    },

    /** The session as stored. */
    async getSession(id: string): Promise<Session> {
      return load(id);
    },

    /** After a failure or a cancel: makes the session runnable again. Finished steps are kept; call run(). */
    async retry(id: string): Promise<Session> {
      const s = await load(id);
      if (s.status !== "failed" && s.status !== "cancelled") return s;
      s.error = undefined;
      await save(s, "analyzing");
      return s;
    },

    /** Your answers to the questions ("I don't have this" counts). Then call run() to continue. */
    async answer(id: string, answers: Answer[]): Promise<Session> {
      const s = await load(id);
      if (s.status !== "needs_input") throw new SessionError(409, `The session isn't waiting for answers (it's ${s.status})`);
      const known = new Set((s.questions ?? []).map((q) => q.id));
      s.answers = answers.filter((a) => known.has(a.questionId));
      s.error = undefined;
      await save(s, "writing");
      return s;
    },

    /** Skip the questions and write with what the resume already shows. */
    async skipQuestions(id: string): Promise<Session> {
      return this.answer(id, []);
    },

    /** The tailored document with only the edits you accepted applied. */
    async finalize(id: string, acceptedEditIds: string[]): Promise<{ source: SourceFiles; facts: Fact[] }> {
      const s = await load(id);
      if (s.status !== "ready" || !s.edits) throw new SessionError(409, "The draft isn't ready");
      const accepted = s.edits.filter((e) => acceptedEditIds.includes(e.id) && e.status !== "dropped");
      const source = await deps.adapter.apply(s.source, s.doc!, accepted);
      return { source, facts: s.newFacts };
    },

    /** Previews a subset of edits (for the review screen's live PDF). */
    async preview(id: string, acceptedEditIds: string[]): Promise<SourceFiles> {
      const s = await load(id);
      if (!s.edits || !s.doc) throw new SessionError(409, "No draft yet");
      return deps.adapter.apply(s.source, s.doc, s.edits.filter((e) => acceptedEditIds.includes(e.id) && e.status !== "dropped"));
    },
  };
}

export type TailorEngine = ReturnType<typeof createTailorEngine>;

// ---- helpers ------------------------------------------------------------------------------------------------

function convert(outs: EditOutput[], startAt: number): { edits: Edit[]; rejected: string[] } {
  const edits: Edit[] = [];
  const rejected: string[] = [];
  outs.forEach((o, i) => {
    const e = toEdit(o, `e${startAt + i}`);
    if (typeof e === "string") rejected.push(e);
    else edits.push(e);
  });
  return { edits, rejected };
}

/** Stable order for review: by edit id number. */
function order(edits: Edit[]): Edit[] {
  return [...edits].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

function stepLabel(step: string): string {
  return (
    {
      "read-posting": "Reading the posting's details",
      "analyze-job": "Reading the job description",
      "match-evidence": "Matching your experience to the requirements",
      "learn-facts": "Adding your answers to your fact bank",
      "write-edits": "Writing the tailored resume",
      "fact-check": "Fact-checking every change against your resume",
      repair: "Fixing changes that overstated the evidence",
      "fit-pages": "Cutting to the page budget",
      build: "Compiling",
    }[step] ?? step
  );
}
