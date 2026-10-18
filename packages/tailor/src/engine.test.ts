import assert from "node:assert/strict";
import { test } from "node:test";
import type { GenerateRequest, LLM } from "@resume-studio/llm";
import type { FormatAdapter } from "./adapters.ts";
import { createTailorEngine } from "./engine.ts";
import type { ResumeDoc } from "./types.ts";

// A scripted model: answers by schema name, so the engine's control flow can be tested without a provider.
function scriptedLLM(script: Record<string, (req: GenerateRequest<unknown>) => unknown>): LLM & { calls: string[] } {
  const calls: string[] = [];
  return {
    provider: "claude-code",
    model: "test",
    calls,
    async generate<T>(req: GenerateRequest<T>) {
      const name = req.schemaName ?? "";
      calls.push(name);
      const f = script[name];
      if (!f) throw new Error(`no script for ${name}`);
      return { data: req.schema.parse(f(req as GenerateRequest<unknown>)), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, provider: "claude-code", model: "test", durationMs: 1 };
    },
  };
}

const doc: ResumeDoc = {
  header: "Dev",
  headline: { id: "h1", text: "Software Engineer" },
  sections: [
    {
      id: "sec1",
      kind: "experience",
      title: "Experience",
      context: "",
      skills: [],
      lists: [{ id: "l1", heading: "Acme", bullets: [
        { id: "b1", text: "Built **Node.js** services on **AWS Lambda**." },
        { id: "b2", text: "Cut failures **60%** with **Temporal**." },
        { id: "b3", text: "Developed a **React** editor." },
      ] }],
    },
  ],
  plainText: "",
};

// The adapter records what it was asked to apply.
const applied: string[][] = [];
const adapter: FormatAdapter = {
  format: "test",
  parse: () => structuredClone(doc),
  apply: (source, _d, edits) => {
    applied.push(edits.map((e) => e.id));
    return source;
  },
};

const edit = (op: string, target: string, text: string | null, evidence: string[] = [target]) => ({
  op,
  target,
  text,
  after: null,
  order: null,
  reason: "r",
  requirements: ["r1"],
  evidence: evidence.map((id) => ({ kind: "bullet", id })),
});

const profile = {
  roleFamily: "backend",
  seniority: "mid",
  summary: "s",
  requirements: [{ text: "Kubernetes", kind: "must", category: "infrastructure", keywords: ["Kubernetes"] }],
  keywords: [{ term: "Kubernetes", aliases: ["K8s"], importance: "must", kind: "term" }],
  responsibilities: [],
  dealBreakers: [],
};

test("every proposed edit is accounted for: kept, repaired or shown as dropped", async () => {
  const llm = scriptedLLM({
    job_profile: () => profile,
    requirement_matches: () => ({ matches: [{ requirementId: "r1", status: "missing", evidence: [], note: "n" }], questions: [] }),
    resume_edits: (req) =>
      String(req.system).includes("fixing resume edits")
        ? { strategy: "fixed", edits: [{ ...edit("rewrite_bullet", "b2", "Cut failures **60%** with **Temporal** workflows."), reason: "Names the workflow engine." }] }
        : {
            strategy: "s",
            edits: [
              edit("set_headline", "h1", "Backend Engineer", ["b1"]),
              edit("rewrite_bullet", "b1", "Built **Node.js** services on **AWS Lambda** at 10M requests/day."), // invented number → repair fails (no fix returned)
              edit("rewrite_bullet", "b2", "Led a platform team cutting failures **60%** with **Temporal**."), // judge: unsupported → repaired
              edit("remove_bullet", "b3", null),
            ],
          },
    fact_check: (req) => ({
      verdicts: [...String(req.prompt).matchAll(/<edit id="(e\d+)">\nBEFORE: [^\n]*\nAFTER: ([^\n]*)/g)].map((m) => ({
        editId: m[1],
        verdict: m[2].startsWith("Led a platform team") ? "unsupported" : "supported",
        problems: m[2].startsWith("Led a platform team") ? ["“Led a platform team” isn't in the evidence"] : [],
      })),
    }),
  });
  const engine = createTailorEngine({ llm, adapter });
  const s0 = await engine.start({ job: { company: "Acme", role: "Backend Engineer", description: "Kubernetes" }, source: { main: "main.tex", files: { "main.tex": "" } } });
  const s = await engine.run(s0.id);
  assert.equal(s.status, "ready", s.error?.message);
  assert.deepEqual(s.fit && [s.fit.level, s.fit.must.total, s.fit.gaps], ["long-shot", 1, ["Kubernetes"]], "the fit is assessed from the matching");
  const byTarget = Object.fromEntries((s.edits ?? []).map((e) => [`${e.change.op}:${e.change.target}:${e.status}`, e]));
  assert.deepEqual(Object.keys(byTarget).sort(), ["remove_bullet:b3:ok", "rewrite_bullet:b1:dropped", "rewrite_bullet:b2:ok", "set_headline:h1:ok"].sort());
  assert.match(byTarget["rewrite_bullet:b2:ok"].revisedFrom!.issues.join(), /“Led a platform team”/, "a repaired edit keeps what was wrong with its first version");
  assert.match(byTarget["rewrite_bullet:b2:ok"].revisedFrom!.text, /^Led a platform team/);
  assert.match(byTarget["rewrite_bullet:b1:dropped"].issues!.join(), /10M/);
  assert.equal(byTarget["rewrite_bullet:b1:dropped"].dropReason, "checks", "a dropped edit says why");
  assert.match(s.report!.warnings.join(), /1 suggestion was left out: not supported by the evidence/);
  assert.equal((byTarget["rewrite_bullet:b2:ok"].change as { text: string }).text, "Cut failures **60%** with **Temporal** workflows.");
  assert.equal(byTarget["rewrite_bullet:b2:ok"].reason, "Names the workflow engine.", "a repaired edit explains itself, not the version it replaced");
  // Ids are unique, and only kept edits reach the document.
  const ids = s.edits!.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(applied.at(-1)!.sort(), s.edits!.filter((e) => e.status !== "dropped").map((e) => e.id).sort());
});

test("questions pause the session; answers become facts and resume it", async () => {
  const llm = scriptedLLM({
    job_profile: () => profile,
    requirement_matches: () => ({
      matches: [{ requirementId: "r1", status: "missing", evidence: [], note: "n" }],
      questions: [{ requirementId: "r1", topic: "Kubernetes", question: "Have you run services on Kubernetes?" }],
    }),
    facts: () => ({ facts: [{ questionId: "q1", text: "Ran the Temporal workers on Kubernetes (AKS).", skills: ["Kubernetes"] }] }),
    resume_edits: (req) => {
      const fact = /FACT \[(f-[^\]]+)\]/.exec(String(req.prompt))?.[1];
      return { strategy: "s", edits: [{ ...edit("rewrite_bullet", "b2", "Cut failures **60%** with **Temporal** workers on **Kubernetes**."), evidence: [{ kind: "bullet", id: "b2" }, { kind: "fact", id: fact }] }] };
    },
    fact_check: () => ({ verdicts: [] }),
  });
  const engine = createTailorEngine({ llm, adapter });
  const s0 = await engine.start({ job: { company: "Acme", role: "Backend Engineer", description: "Kubernetes" }, source: { main: "main.tex", files: { "main.tex": "" } } });
  const paused = await engine.run(s0.id);
  assert.equal(paused.status, "needs_input");
  assert.equal(paused.questions![0].id, "q1");
  await engine.answer(s0.id, [{ questionId: "q1", text: "I ran our Temporal workers on AKS." }]);
  const done = await engine.run(s0.id);
  assert.equal(done.status, "ready", done.error?.message);
  assert.equal(done.newFacts.length, 1);
  assert.equal(done.matches![0].status, "strong");
  assert.equal(done.edits![0].status, "ok", done.edits![0].issues?.join());
  assert.deepEqual(llm.calls, ["job_profile", "requirement_matches", "facts", "resume_edits", "fact_check"]);
});

test("a failed run resumes with retry, keeping the steps that finished", async () => {
  let limited = true;
  const llm = scriptedLLM({
    job_profile: () => profile,
    requirement_matches: () => ({ matches: [{ requirementId: "r1", status: "missing", evidence: [], note: "n" }], questions: [] }),
    resume_edits: () => {
      if (limited) throw new Error("usage limit reached");
      return { strategy: "s", edits: [edit("rewrite_bullet", "b2", "Cut failures **60%** using **Temporal**.")] };
    },
    fact_check: (req) => ({ verdicts: [...String(req.prompt).matchAll(/<edit id="(e\d+)">/g)].map((m) => ({ editId: m[1], verdict: "supported", problems: [] })) }),
  });
  const engine = createTailorEngine({ llm, adapter });
  const s0 = await engine.start({ job: { company: "Acme", role: "Backend Engineer", description: "Kubernetes" }, source: { main: "main.tex", files: { "main.tex": "" } } });
  const failed = await engine.run(s0.id);
  assert.equal(failed.status, "failed");
  assert.equal((await engine.run(s0.id)).status, "failed", "run() alone retries a failed session too, and fails the same way");

  limited = false;
  const before = llm.calls.length;
  assert.equal((await engine.retry(s0.id)).status, "analyzing");
  const done = await engine.run(s0.id);
  assert.equal(done.status, "ready", done.error?.message);
  assert.equal(done.error, undefined);
  // The job analysis and matching weren't redone.
  assert.deepEqual(llm.calls.slice(before), ["resume_edits", "fact_check"]);
  assert.equal((await engine.getSession(s0.id)).status, "ready");
});

test("a pasted posting alone is enough: the engine reads its title, level and location", async () => {
  const llm = scriptedLLM({
    posting_details: () => ({ company: null, role: "Founding Engineer", suggestedRole: "Founding Engineer", seniority: "mid", location: "Bangalore", workModel: "onsite" }),
    job_profile: () => profile,
    requirement_matches: () => ({ matches: [{ requirementId: "r1", status: "strong", evidence: [{ kind: "bullet", id: "b1" }], note: "n" }], questions: [] }),
    resume_edits: () => ({ strategy: "s", edits: [] }),
    fact_check: () => ({ verdicts: [] }),
  });
  const engine = createTailorEngine({ llm, adapter });
  const s0 = await engine.start({ job: { company: "", role: "", description: "A YC-backed Voice AI company is hiring. ".repeat(5) }, source: { main: "main.tex", files: { "main.tex": "" } } });
  const s = await engine.run(s0.id);
  assert.equal(s.status, "ready", s.error?.message);
  assert.equal(llm.calls[0], "posting_details");
  assert.deepEqual([s.job.role, s.job.company, s.job.seniority, s.job.location], ["Founding Engineer", "", "mid", "Bangalore"], "an unnamed company stays unnamed");
  // Retried or resumed, it isn't read twice.
  await engine.retry(s.id);
  assert.equal(llm.calls.filter((c) => c === "posting_details").length, 1);
});

test("a 'haven't done this' is remembered: never evidence, shown to later runs as not done", async () => {
  const saved: import("./types.ts").Fact[] = [];
  const facts = { list: async () => saved, add: async (f: import("./types.ts").Fact[]) => void saved.push(...f) };
  let matchPrompt = "";
  const llm = scriptedLLM({
    job_profile: () => profile,
    requirement_matches: (req) => {
      matchPrompt = String(req.prompt);
      return {
        matches: [{ requirementId: "r1", status: "missing", evidence: [], note: "n" }],
        questions: saved.length ? [] : [{ requirementId: "r1", topic: "Kubernetes", question: "Have you run services on Kubernetes?" }],
      };
    },
    resume_edits: (req) => {
      const lacks = /FACT \[(f-[^\]]+)\]/.exec(String(req.prompt))?.[1];
      // A model that tries to cite the declined topic anyway.
      return { strategy: "s", edits: [{ ...edit("rewrite_bullet", "b2", "Cut failures **60%** using **Temporal**."), evidence: [{ kind: "bullet", id: "b2" }, ...(lacks ? [{ kind: "fact", id: lacks }] : [{ kind: "fact", id: saved[0]?.id ?? "x" }])] }] };
    },
    fact_check: (req) => ({ verdicts: [...String(req.prompt).matchAll(/<edit id="(e\d+)">/g)].map((m) => ({ editId: m[1], verdict: "supported", problems: [] })) }),
    repair: () => ({ strategy: "s", edits: [] }),
  });
  const engine = createTailorEngine({ llm, adapter, facts });
  const s0 = await engine.start({ job: { company: "Acme", role: "Backend Engineer", description: "Kubernetes" }, source: { main: "main.tex", files: { "main.tex": "" } } });
  assert.equal((await engine.run(s0.id)).status, "needs_input");
  await engine.answer(s0.id, [{ questionId: "q1", none: true }]);
  const done = await engine.run(s0.id);
  assert.equal(done.status, "ready", done.error?.message);
  assert.equal(saved.length, 1);
  assert.deepEqual([saved[0].kind, saved[0].topic], ["lacks", "Kubernetes"], "kept as a topic they lack");
  assert.deepEqual(done.newFacts, [], "not a fact learned from the answers");
  assert.equal(done.edits![0].status, "dropped", "an edit can't cite it");
  assert.match(done.edits![0].issues!.join(), /said they haven't done/);

  // The next run is told, and isn't asked again.
  const s1 = await engine.start({ job: { company: "Beta", role: "Backend Engineer", description: "Kubernetes" }, source: { main: "main.tex", files: { "main.tex": "" } } });
  const next = await engine.run(s1.id);
  assert.match(matchPrompt, /NOT DONE: Kubernetes/);
  assert.doesNotMatch(matchPrompt, /FACT \[/, "not shown as something they did");
  assert.notEqual(next.status, "needs_input");
});

test("the review's choice of edits is saved with each preview", async () => {
  const llm = scriptedLLM({
    job_profile: () => profile,
    requirement_matches: () => ({ matches: [{ requirementId: "r1", status: "missing", evidence: [], note: "n" }], questions: [] }),
    resume_edits: () => ({ strategy: "s", edits: [edit("rewrite_bullet", "b2", "Cut failures **60%** using **Temporal**."), edit("remove_bullet", "b3", "")] }),
    fact_check: (req) => ({ verdicts: [...String(req.prompt).matchAll(/<edit id="(e\d+)">/g)].map((m) => ({ editId: m[1], verdict: "supported", problems: [] })) }),
  });
  const engine = createTailorEngine({ llm, adapter });
  const s0 = await engine.start({ job: { company: "Acme", role: "Backend Engineer", description: "Kubernetes" }, source: { main: "main.tex", files: { "main.tex": "" } } });
  const s = await engine.run(s0.id);
  assert.equal(s.selection, undefined, "nothing chosen yet");
  await engine.preview(s0.id, ["e2", "nope"]);
  assert.deepEqual((await engine.getSession(s0.id)).selection, ["e2"], "only real, kept edits");
});
