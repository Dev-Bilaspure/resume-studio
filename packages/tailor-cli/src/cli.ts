#!/usr/bin/env node
// resume-tailor: tailors a LaTeX resume to a job description from the command line.
//   resume-tailor <resume-dir> --jd jd.txt --company Acme --role "Backend Engineer" [--main main.tex]
//     [--seniority mid] [--provider claude-code] [--model opus] [--out tailored.tex] [--sessions dir]
// Gap questions are answered from --answers "topic=what you did;…" (matched against each question's topic
// and text); the rest are answered "I don't have this".
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { createLLM, type ProviderId } from "@resume-studio/llm";
import { createTailorEngine, type Seniority } from "@resume-studio/tailor";
import { fileSessionStore } from "@resume-studio/tailor/node";
import { latexAdapter } from "@resume-studio/tailor-latex";
import { latexmkVerifier } from "@resume-studio/tailor-latex/node";

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    jd: { type: "string" },
    company: { type: "string" },
    role: { type: "string" },
    seniority: { type: "string" },
    main: { type: "string", default: "main.tex" },
    provider: { type: "string", default: "claude-code" },
    model: { type: "string", default: "opus" },
    answers: { type: "string", default: "" },
    out: { type: "string" },
    sessions: { type: "string", default: join(tmpdir(), "tailor-sessions") },
  },
});
const dir = positionals[0];
if (!dir || !opt.jd || !opt.company || !opt.role) {
  console.error('usage: resume-tailor <resume-dir> --jd jd.txt --company <name> --role "<exact title>" [--main main.tex] [--seniority mid] [--provider claude-code] [--model opus] [--answers "topic=…;…"] [--out tailored.tex]');
  process.exit(2);
}
const main = opt.main!;
const jdPath = opt.jd;
const provider = opt.provider!;
const model = opt.model!;
const files: Record<string, string> = {};
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (statSync(f).isDirectory()) walk(f);
    else if (/\.(tex|cls|sty|bib)$/.test(n)) files[relative(dir, f)] = readFileSync(f, "utf8");
  }
};
walk(dir);

// Compiled with the local TeX installation; the resume folder's other files (images, fonts) come along.
const verifier = latexmkVerifier({ assetsDir: dir });

const t0 = Date.now();
const engine = createTailorEngine({
  llm: createLLM({ provider: provider as ProviderId, model }),
  adapter: latexAdapter,
  verifier,
  store: fileSessionStore(opt.sessions!),
  onEvent: (_id, e) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${e.type}: ${e.message}`),
});
let s = await engine.start({
  job: { company: opt.company, role: opt.role, seniority: opt.seniority as Seniority | undefined, description: readFileSync(jdPath, "utf8") },
  source: { main, files },
});
s = await engine.run(s.id);
if (s.status === "needs_input") {
  console.log("\nQUESTIONS:");
  for (const q of s.questions!) console.log(`  [${q.id}] (${q.topic}) ${q.question}`);
  const given = opt.answers!.split(";").filter(Boolean).map((kv) => kv.split("=") as [string, string]);
  const answers = s.questions!.map((q) => {
    const hit = given.find(([k]) => `${q.topic} ${q.question}`.toLowerCase().includes(k.toLowerCase()));
    return hit ? { questionId: q.id, text: hit[1] } : { questionId: q.id, none: true };
  });
  console.log("ANSWERS:", JSON.stringify(answers));
  await engine.answer(s.id, answers);
  s = await engine.run(s.id);
}
console.log(`\nSTATUS: ${s.status} ${s.error ? JSON.stringify(s.error) : ""}`);
if (s.profile) {
  console.log("\nREQUIREMENTS:");
  for (const r of s.profile.requirements) {
    const m = s.matches?.find((x) => x.requirementId === r.id);
    console.log(`  [${r.id}] ${r.kind.padEnd(4)} ${m?.status.padEnd(7)} ${r.text}  — ${m?.note}`);
  }
}
if (s.strategy) console.log(`\nSTRATEGY: ${s.strategy}`);
for (const e of s.edits ?? []) {
  console.log(`\n${e.id} ${e.status?.toUpperCase()} ${e.change.op} ${e.change.target}${"text" in e.change ? `\n   → ${e.change.text}` : ""}${"order" in e.change ? `\n   → ${e.change.order.join(", ")}` : ""}\n   why: ${e.reason}\n   evidence: ${e.evidence.map((x) => x.id).join(", ")}${e.issues?.length ? `\n   issues: ${e.issues.join(" | ")}` : ""}`);
}
if (s.report) {
  const b = s.report.before;
  const a = s.report.after;
  console.log(`\nREPORT: pages ${b.build?.pages} → ${a.build?.pages}; must-have keywords ${b.keywordsFound.length}/${b.keywordsFound.length + b.keywordsMissing.length} → ${a.keywordsFound.length}/${a.keywordsFound.length + a.keywordsMissing.length} (missing after: ${a.keywordsMissing.join(", ")}); requirements strong ${b.requirementsStrong} → ${a.requirementsStrong} of ${b.requirementsTotal}`);
  console.log(`WARNINGS: ${s.report.warnings.join(" | ")}`);
}
console.log(`SESSION: ${s.id}`);
console.log(`\nUSAGE: ${s.usage.calls} calls, ${s.usage.inputTokens} in / ${s.usage.outputTokens} out, ${((Date.now() - t0) / 1000).toFixed(0)}s`, JSON.stringify(Object.fromEntries(Object.entries(s.usage.byStep).map(([k, v]) => [k, `${(v.ms / 1000).toFixed(0)}s`]))));
if (s.draft && opt.out) {
  writeFileSync(opt.out, s.draft.files[main]);
  console.log(`\nWROTE: ${opt.out}`);
}
