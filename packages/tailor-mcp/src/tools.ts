// What the MCP tools do, independent of the protocol: tailor a resume on this machine, answer the
// engine's questions, read a session, and save the result as a new folder. Results are written for an
// assistant to read and relay: what happened, what changed and why, and what to call next.
import { resolve } from "node:path";
import { createLLM, type LLM, type ProviderConfig } from "@resume-studio/llm";
import { createTailorEngine, jobCompany, jobTitle, type Answer, type Edit, type FactStore, type Seniority, type Session, type SessionStore } from "@resume-studio/tailor";
import { latexAdapter } from "@resume-studio/tailor-latex";
import { latexmkVerifier, readResumeFolder, writeResumeFolder } from "@resume-studio/tailor-latex/node";

export interface ToolsDeps {
  provider: ProviderConfig;
  store: SessionStore;
  facts: FactStore;
  /** Tests swap in a scripted model. */
  createLLM?: (c: ProviderConfig) => LLM;
}

const WORKING = new Set<Session["status"]>(["created", "analyzing", "writing", "verifying"]);

export function createTools(deps: ToolsDeps) {
  const running = new Map<string, Promise<unknown>>();
  const listeners = new Map<string, (message: string) => void>();
  const makeLLM = deps.createLLM ?? createLLM;

  function engine(resumeDir: string) {
    return createTailorEngine({
      llm: makeLLM(deps.provider),
      adapter: latexAdapter,
      verifier: latexmkVerifier({ assetsDir: resumeDir }),
      store: deps.store,
      facts: deps.facts,
      onEvent: (id, e) => e.type === "step" && listeners.get(id)?.(e.message),
    });
  }

  async function load(id: string) {
    const s = await deps.store.get(id).catch(() => null);
    if (!s) throw new Error(`No tailoring session ${id}`);
    return s;
  }

  function startRun(s: Session) {
    if (running.has(s.id)) return;
    const p = engine(s.context.resumeDir)
      .run(s.id)
      .finally(() => running.delete(s.id));
    running.set(s.id, p);
  }

  /** Waits until the session stops working or the time is up, reporting steps as they happen. */
  async function waitFor(id: string, seconds: number, onProgress?: (m: string) => void) {
    if (onProgress) listeners.set(id, onProgress);
    try {
      const end = Date.now() + seconds * 1000;
      for (;;) {
        const s = await load(id);
        if (!WORKING.has(s.status) || Date.now() >= end) return s;
        const run = running.get(id);
        if (!run) return s; // interrupted: nothing is running it
        await Promise.race([run, new Promise((r) => setTimeout(r, Math.min(2000, Math.max(0, end - Date.now()))))]).catch(() => {});
      }
    } finally {
      listeners.delete(id);
    }
  }

  return {
    async tailor(args: {
      resumePath: string;
      jobDescription: string;
      company?: string;
      role?: string;
      seniority?: Seniority;
      maxPages?: number;
      askQuestions?: boolean;
      waitSeconds?: number;
      onProgress?: (m: string) => void;
    }) {
      const { dir, source } = readResumeFolder(args.resumePath);
      const s = await engine(dir).start({
        job: { company: args.company ?? "", role: args.role ?? "", seniority: args.seniority, description: args.jobDescription },
        source,
        options: { maxPages: args.maxPages, askQuestions: args.askQuestions ?? true },
        context: { resumeDir: dir, resumePath: resolve(args.resumePath) },
      });
      startRun(s);
      return describe(await waitFor(s.id, args.waitSeconds ?? 240, args.onProgress), running.has(s.id));
    },

    async answer(args: { sessionId: string; answers: { questionId: string; answer?: string; none?: boolean }[]; waitSeconds?: number; onProgress?: (m: string) => void }) {
      const s = await load(args.sessionId);
      const answers: Answer[] = args.answers.map((a) => (a.answer?.trim() && !a.none ? { questionId: a.questionId, text: a.answer.trim() } : { questionId: a.questionId, none: true }));
      await engine(s.context.resumeDir).answer(s.id, answers);
      startRun(await load(s.id));
      return describe(await waitFor(s.id, args.waitSeconds ?? 240, args.onProgress), running.has(s.id));
    },

    async get(args: { sessionId: string; waitSeconds?: number; onProgress?: (m: string) => void }) {
      let s = await load(args.sessionId);
      // Interrupted (this server restarted mid-run): pick it up again.
      if (WORKING.has(s.status) && !running.has(s.id)) startRun(s);
      if (args.waitSeconds) s = await waitFor(s.id, args.waitSeconds, args.onProgress);
      return describe(s, running.has(s.id));
    },

    async save(args: { sessionId: string; outputDir: string; rejectEditIds?: string[] }) {
      const s = await load(args.sessionId);
      if (s.status !== "ready") throw new Error(`The session isn't ready (it's ${s.status}).`);
      const reject = new Set(args.rejectEditIds ?? []);
      const accepted = (s.edits ?? []).filter((e) => e.status !== "dropped" && !reject.has(e.id)).map((e) => e.id);
      const { source } = await engine(s.context.resumeDir).finalize(s.id, accepted);
      const out = writeResumeFolder(s.context.resumeDir, args.outputDir, source, { "jd.md": `# ${jobTitle(s.job)} · ${jobCompany(s.job)}\n\n${s.job.description.trim()}\n` });
      return `Saved to ${out} with ${accepted.length} of ${(s.edits ?? []).filter((e) => e.status !== "dropped").length} changes (main file: ${source.main}; the job description is in jd.md). The original at ${s.context.resumeDir} is unchanged.`;
    },
  };
}

// ---- Describing a session for an assistant --------------------------------------------------------------

function plain(markup: string) {
  return markup.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2");
}

function original(s: Session, e: Edit): string | null {
  const c = e.change;
  const doc = s.doc;
  if (!doc) return null;
  if (c.op === "set_headline") return doc.headline?.text ?? null;
  for (const sec of doc.sections) {
    if (sec.paragraph?.id === c.target) return sec.paragraph.text;
    for (const k of sec.skills) if (k.id === c.target) return `${k.label ? `${k.label}: ` : ""}${k.text}`;
    for (const l of sec.lists) for (const b of l.bullets) if (b.id === c.target) return b.text;
  }
  return null;
}

export function describe(s: Session, running: boolean): string {
  const head = `Session ${s.id} · ${jobTitle(s.job)} at ${jobCompany(s.job)} · ${s.status}`;
  if (WORKING.has(s.status)) {
    const last = [...s.events].reverse().find((e) => e.type === "step");
    return running
      ? `${head}\nStill working (${last?.message ?? "starting"}). Call get_tailoring_session with this session_id and wait_seconds to continue waiting.`
      : `${head}\nThis run was interrupted. Call get_tailoring_session to resume it.`;
  }
  if (s.status === "failed") return `${head}\nFailed: ${s.error?.message ?? "unknown error"}`;
  if (s.status === "cancelled") return `${head}\nCancelled.`;
  if (s.status === "needs_input") {
    const qs = (s.questions ?? []).map((q) => `- [${q.id}] (${q.topic}) ${q.question}`).join("\n");
    return `${head}\nThe job asks for things the resume doesn't show yet. Ask the candidate these, and use answer_tailoring_questions with their own words; a question they haven't done anything for is answered with none: true. Never answer for them.\n${qs}`;
  }
  const r = s.report!;
  const kept = (s.edits ?? []).filter((e) => e.status !== "dropped");
  const dropped = (s.edits ?? []).filter((e) => e.status === "dropped");
  const lines = [
    head,
    `Approach: ${s.strategy ?? ""}`,
    `Requirements clearly shown: ${r.before.requirementsStrong} → ${r.after.requirementsStrong} of ${r.before.requirementsTotal}. Must-have keywords: ${r.before.keywordsFound.length} → ${r.after.keywordsFound.length} of ${r.before.keywordsFound.length + r.before.keywordsMissing.length}${r.after.keywordsMissing.length ? ` (not claimed, no evidence: ${r.after.keywordsMissing.join(", ")})` : ""}. Pages: ${r.before.build?.pages ?? "?"} → ${r.after.build?.pages ?? "?"}.`,
    ...(r.warnings.length ? [`Warnings: ${r.warnings.join(" ")}`] : []),
    ``,
    `Changes (${kept.length}):`,
    ...kept.map((e) => {
      const before = original(s, e);
      const text = "text" in e.change ? plain(e.change.text) : e.change.op === "reorder_bullets" ? `new order: ${e.change.order.join(", ")}` : "(removed)";
      return `- [${e.id}] ${e.change.op}${e.status === "flagged" ? " (check this)" : ""}: ${before ? `"${plain(before)}" → ` : ""}"${text}"\n  why: ${e.reason}`;
    }),
    ...(dropped.length ? [``, `Left out after the fact-check (${dropped.length}): ${dropped.map((e) => `[${e.id}] ${(e.issues ?? []).join(" ")}`).join("; ")}`] : []),
    ``,
    `To keep it: save_tailored_resume with this session_id and a new output_dir (pass reject_edit_ids to leave changes out).`,
  ];
  return lines.join("\n");
}
