#!/usr/bin/env node
// resume-tailor: tailors a LaTeX resume to a job posting from the command line.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { LLMError, createLLM, type ProviderId } from "@resume-studio/llm";
import { defaultModelsFromEnv, providersFromEnv } from "@resume-studio/llm/env";
import { createTailorEngine, type Answer, type Edit, type Seniority, type Session } from "@resume-studio/tailor";
import { fileFactStore, fileSessionStore } from "@resume-studio/tailor/node";
import { latexAdapter } from "@resume-studio/tailor-latex";
import { latexmkVerifier, readResumeFolder, writeResumeFolder } from "@resume-studio/tailor-latex/node";

const USAGE = `Usage: resume-tailor <resume.tex | resume folder> --jd <posting.txt | -> --company <name> --role "<exact title>" [options]

Tailors the resume to the job: every requirement is matched to your experience, the relevant parts are
rewritten in the job's language, and every change is fact-checked against your resume and compiled.

Options:
  --level <intern|junior|mid|senior|staff|principal|manager>   the role's level (default: read from the posting)
  --pages <n>            page budget (default: the resume's current length)
  --no-questions         don't ask about must-haves the resume doesn't show
  --answers <file.json>  answers to the questions, for scripts: [{"topic": "Terraform", "answer": "…"}]
  --out <folder>         save the tailored resume as a new folder (the original is never changed)
  --reject <e1,e3>       leave these changes out of what --out saves
  --provider <id>        claude-code, anthropic, openai or vertex (default: from the environment, else Claude Code)
  --model <id>           the model (default: per provider)
  --json                 print the session as JSON instead of a summary
  --data <folder>        where sessions and your facts are kept (default ~/.resume-tailor)

Questions are asked in the terminal; press Enter for "I haven't done this". Your answers are saved as facts
for next time (shared with resume-tailor-mcp).

Exit codes: 0 tailored, 1 failed, 2 usage, 3 usage limit reached (run again later).`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    jd: { type: "string" },
    company: { type: "string" },
    role: { type: "string" },
    level: { type: "string" },
    pages: { type: "string" },
    "no-questions": { type: "boolean", default: false },
    answers: { type: "string" },
    out: { type: "string" },
    reject: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    json: { type: "boolean", default: false },
    data: { type: "string", default: join(homedir(), ".resume-tailor") },
    help: { type: "boolean", short: "h", default: false },
  },
});

function usage(message?: string): never {
  if (message) console.error(`${message}\n`);
  console.error(USAGE);
  process.exit(opt.help ? 0 : 2);
}

if (opt.help) usage();
const resumePath = positionals[0];
if (!resumePath || !opt.jd || !opt.company || !opt.role) usage("Missing the resume, --jd, --company or --role.");
const LEVELS = ["intern", "junior", "mid", "senior", "staff", "principal", "manager"];
if (opt.level && !LEVELS.includes(opt.level)) usage(`--level must be one of ${LEVELS.join(", ")}`);

// ---- Setup ---------------------------------------------------------------------------------------------------

function attempt<T>(what: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    usage(err.code === "ENOENT" ? `${what}: no such file: ${err.path}` : `${what}: ${err.message}`);
  }
}
const { dir, source } = attempt("Resume", () => readResumeFolder(resumePath));
const description = attempt("Job posting", () => (opt.jd === "-" ? readFileSync(0, "utf8") : readFileSync(opt.jd!, "utf8")).trim());
if (description.length < 80) usage("The job posting looks incomplete: paste the whole posting into the --jd file.");
const providers = providersFromEnv(process.env, { claudeCode: true });
const chosen = providers.find((p) => p.provider === ((opt.provider ?? process.env.TAILOR_PROVIDER) as ProviderId)) ?? (opt.provider ? undefined : providers[0]);
if (!chosen) usage(`No credentials for ${opt.provider}. Set its API key in the environment (see --help).`);
const model = opt.model ?? defaultModelsFromEnv()[chosen.provider];
if (!model) usage(`Name a model for ${chosen.provider} with --model.`);

const tty = process.stderr.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const green = (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
const t0 = Date.now();
const log = (m: string) => console.error(dim(`  ${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s  `) + m);

const engine = createTailorEngine({
  llm: createLLM({ ...chosen, model }),
  adapter: latexAdapter,
  verifier: latexmkVerifier({ assetsDir: dir }),
  store: fileSessionStore(join(opt.data!, "sessions")),
  facts: fileFactStore(join(opt.data!, "facts.json")),
  onEvent: (_id, e) => (e.type === "step" || e.type === "warning" ? log(e.message) : undefined),
});

// ---- Questions -------------------------------------------------------------------------------------------------

async function answerQuestions(s: Session): Promise<Answer[]> {
  const questions = s.questions ?? [];
  if (opt.answers) {
    const given = JSON.parse(readFileSync(opt.answers, "utf8")) as { topic?: string; question?: string; answer?: string }[];
    return questions.map((q) => {
      const hit = given.find((g) => (g.topic && q.topic.toLowerCase().includes(g.topic.toLowerCase())) || (g.question && q.question.toLowerCase().includes(g.question.toLowerCase())));
      return hit?.answer?.trim() ? { questionId: q.id, text: hit.answer.trim() } : { questionId: q.id, none: true };
    });
  }
  if (!process.stdin.isTTY || opt.jd === "-") {
    log(`Skipping ${questions.length} question${questions.length === 1 ? "" : "s"} (no terminal; use --answers for scripts).`);
    return [];
  }
  console.error(`\n${bold("A few must-haves aren't on your resume yet.")} If you've done any of these, say where and what, briefly.`);
  console.error(dim("Answers are used as written and saved for next time. Press Enter for \"I haven't done this\".\n"));
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const out: Answer[] = [];
  for (const [i, q] of questions.entries()) {
    const a = (await rl.question(`${bold(`${i + 1}. ${q.topic}`)}: ${q.question}\n   > `)).trim();
    out.push(a ? { questionId: q.id, text: a } : { questionId: q.id, none: true });
  }
  rl.close();
  console.error("");
  return out;
}

// ---- Output ----------------------------------------------------------------------------------------------------

function plain(m: string) {
  return m.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2");
}

function originalText(s: Session, e: Edit): string | null {
  const c = e.change;
  if (!s.doc) return null;
  if (c.op === "set_headline") return s.doc.headline?.text ?? null;
  for (const sec of s.doc.sections) {
    if (sec.paragraph?.id === c.target) return sec.paragraph.text;
    for (const k of sec.skills) if (k.id === c.target) return k.text;
    for (const l of sec.lists) for (const b of l.bullets) if (b.id === c.target) return b.text;
  }
  return null;
}

function summary(s: Session) {
  const r = s.report!;
  const kw = r.before.keywordsFound.length + r.before.keywordsMissing.length;
  const lines = [
    "",
    bold(`${s.job.role} · ${s.job.company}`),
    `${dim("Approach")}  ${s.strategy ?? ""}`,
    `${dim("Requirements clearly shown")}  ${r.before.requirementsStrong} → ${green(String(r.after.requirementsStrong))} of ${r.before.requirementsTotal}    ${dim("Must-have keywords")}  ${r.before.keywordsFound.length} → ${green(String(r.after.keywordsFound.length))} of ${kw}    ${dim("Pages")}  ${r.before.build?.pages ?? "?"} → ${r.after.build?.pages ?? "?"}`,
  ];
  if (r.after.keywordsMissing.length) lines.push(dim(`Not claimed (no evidence on your resume): ${r.after.keywordsMissing.join(", ")}`));
  for (const w of r.warnings) lines.push(`${dim("!")} ${w}`);
  const kept = (s.edits ?? []).filter((e) => e.status !== "dropped");
  lines.push("", bold(`Changes (${kept.length})`));
  for (const e of kept) {
    const before = originalText(s, e);
    const after = "text" in e.change ? plain(e.change.text) : e.change.op === "reorder_bullets" ? `(reordered: ${e.change.order.join(", ")})` : "(removed)";
    lines.push(`  ${bold(e.id)} ${e.change.op}${e.status === "flagged" ? red(" · check this") : ""}`);
    if (before && e.change.op !== "reorder_bullets") lines.push(`     ${red("-")} ${plain(before)}`);
    lines.push(`     ${green("+")} ${after}`, `     ${dim(e.reason)}`);
  }
  const dropped = (s.edits ?? []).filter((e) => e.status === "dropped");
  if (dropped.length) lines.push("", dim(`Left out after the fact-check: ${dropped.map((e) => `${e.id} (${(e.issues ?? []).join(" ")})`).join("; ")}`));
  return lines.join("\n");
}

// ---- Run -------------------------------------------------------------------------------------------------------

log(`Tailoring ${source.main} for ${opt.role} at ${opt.company} · ${chosen.provider} · ${model}`);
let s = await engine.start({
  job: { company: opt.company!, role: opt.role!, seniority: opt.level as Seniority | undefined, description },
  source,
  options: { maxPages: opt.pages ? Number(opt.pages) : undefined, askQuestions: !opt["no-questions"] },
});
const ctl = new AbortController();
process.on("SIGINT", () => ctl.abort());
s = await engine.run(s.id, ctl.signal);
if (s.status === "needs_input") {
  await engine.answer(s.id, await answerQuestions(s));
  s = await engine.run(s.id, ctl.signal);
}

if (s.status !== "ready") {
  console.error(red(`\n${s.status === "cancelled" ? "Cancelled." : `Failed: ${s.error?.message ?? "unknown error"}`}`));
  if (s.status === "failed") console.error(dim(`Session ${s.id}: run again with the same arguments, or inspect ${join(opt.data!, "sessions", `${s.id}.json`)}`));
  process.exit(s.error?.kind === "rate_limit" ? 3 : 1);
}

if (opt.json) {
  const { source: _s, draft: _d, ...rest } = s;
  void _s;
  void _d;
  console.log(JSON.stringify(rest, null, 2));
} else {
  console.log(summary(s));
}

if (opt.out) {
  const reject = new Set((opt.reject ?? "").split(",").map((x) => x.trim()).filter(Boolean));
  const accepted = (s.edits ?? []).filter((e) => e.status !== "dropped" && !reject.has(e.id)).map((e) => e.id);
  const { source: tailored } = await engine.finalize(s.id, accepted);
  try {
    const out = writeResumeFolder(dir, opt.out, tailored, { "jd.md": `# ${s.job.role} · ${s.job.company}\n\n${s.job.description}\n` });
    console.error(green(`\nSaved to ${out} (${accepted.length} change${accepted.length === 1 ? "" : "s"}; the job description is in jd.md).`));
  } catch (e) {
    console.error(red(`\nNot saved: ${(e as Error).message}`));
    process.exit(1);
  }
} else if (!opt.json) {
  console.error(dim(`\nSave it with --out <new folder> (and --reject e2,e5 to leave changes out).`));
}

process.on("unhandledRejection", (e) => {
  console.error(red(e instanceof LLMError ? e.message : String(e)));
  process.exit(1);
});
