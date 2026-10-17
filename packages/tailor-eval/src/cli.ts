// tailor-eval: measures whether tailoring helps and stays honest.
//   tailor-eval run [--data eval-data] [--out eval-results/<name>] [--provider claude-code] [--model sonnet]
//                   [--judge-provider claude-code] [--judge-model opus] [--only <substring,…>] [--limit N]
//   tailor-eval report <run folder>
// A run saves each case as it finishes; running again with the same --out continues where it stopped
// (after a usage limit, say). Cases that finished are never redone.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createLLM, type ProviderId } from "@resume-studio/llm";
import { loadCases } from "./data.ts";
import { markdownReport, summarize } from "./report.ts";
import { isStopError, runCase, type CaseResult } from "./run.ts";

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: "string", default: "eval-data" },
    out: { type: "string" },
    provider: { type: "string", default: "claude-code" },
    model: { type: "string", default: "sonnet" },
    "judge-provider": { type: "string" },
    "judge-model": { type: "string", default: "opus" },
    only: { type: "string" },
    limit: { type: "string" },
  },
});
const [command, arg] = positionals;
const cwd = process.env.INIT_CWD ?? process.cwd();

function readResults(dir: string): CaseResult[] {
  const casesDir = join(dir, "cases");
  if (!existsSync(casesDir)) return [];
  return readdirSync(casesDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(casesDir, f), "utf8")) as CaseResult);
}

function writeReport(dir: string) {
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { engine: string; judge: string; startedAt: string };
  const results = readResults(dir);
  writeFileSync(join(dir, "report.md"), markdownReport(results, meta));
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summarize(results), null, 2) + "\n");
  return results;
}

if (command === "report") {
  if (!arg) throw new Error("usage: tailor-eval report <run folder>");
  const dir = resolve(cwd, arg);
  writeReport(dir);
  process.stdout.write(readFileSync(join(dir, "report.md"), "utf8"));
} else if (command === "run") {
  const dataDir = resolve(cwd, opt.data!);
  const outDir = resolve(cwd, opt.out ?? join("eval-results", new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")));
  mkdirSync(join(outDir, "cases"), { recursive: true });

  const engineLLM = createLLM({ provider: opt.provider as ProviderId, model: opt.model! });
  const judgeLLM = createLLM({ provider: (opt["judge-provider"] ?? opt.provider) as ProviderId, model: opt["judge-model"]! });
  const metaFile = join(outDir, "meta.json");
  if (!existsSync(metaFile)) {
    writeFileSync(metaFile, JSON.stringify({ engine: `${engineLLM.provider} · ${engineLLM.model}`, judge: `${judgeLLM.provider} · ${judgeLLM.model}`, startedAt: new Date().toISOString(), data: dataDir }, null, 2) + "\n");
  }

  let cases = loadCases(dataDir);
  if (opt.only) {
    const keys = opt.only.split(",").map((k) => k.trim()).filter(Boolean);
    cases = cases.filter((c) => keys.some((k) => c.id.includes(k)));
  }
  const done = new Set(readResults(outDir).map((r) => r.id));
  let todo = cases.filter((c) => !done.has(c.id));
  if (opt.limit) todo = todo.slice(0, Number(opt.limit));
  console.log(`${cases.length} cases, ${done.size} already done, running ${todo.length} → ${outDir}`);

  const ctl = new AbortController();
  process.on("SIGINT", () => ctl.abort());
  let stopped: string | null = null;
  for (const [i, c] of todo.entries()) {
    const t0 = Date.now();
    const log = (m: string) => console.log(`  [${i + 1}/${todo.length}] ${c.id} · ${Math.round((Date.now() - t0) / 1000)}s · ${m}`);
    log("starting");
    try {
      const r = await runCase(c, { engineLLM, judgeLLM, signal: ctl.signal, onStep: log });
      writeFileSync(join(outDir, "cases", `${c.id}.json`), JSON.stringify(r, null, 2) + "\n");
      const yn = (b?: boolean) => (b === undefined ? "–" : b ? "yes" : "no");
      log(`${r.status}: advanced ${yn(r.screen?.original.advance)} → ${yn(r.screen?.tailored.advance)}, fit ${r.screen ? `${r.screen.original.fit} → ${r.screen.tailored.fit}` : "–"}, audit ${r.audit ? r.audit.issues.length : "–"} issue(s)`);
    } catch (e) {
      if (isStopError(e)) {
        stopped = (e as Error).message;
        break;
      }
      // Anything else is this case's failure: recorded, and the run goes on.
      log(`error: ${(e as Error).message}`);
      writeFileSync(
        join(outDir, "cases", `${c.id}.json`),
        JSON.stringify({ id: c.id, resume: c.resume.id, jd: c.posting.id, posting: c.posting, status: "failed", error: (e as Error).message, engine: {}, judge: {}, finishedAt: new Date().toISOString() }, null, 2) + "\n",
      );
    }
  }
  const results = writeReport(outDir);
  const s = summarize(results);
  console.log(`\n${s.ready}/${s.cases} tailored · advanced ${s.originalAdvanced} → ${s.tailoredAdvanced} of ${s.screened} (gained ${s.gained}, lost ${s.lost}) · audit clean ${s.audit.clean}/${s.audit.audited}`);
  console.log(`Report: ${join(outDir, "report.md")}`);
  if (stopped) {
    console.log(`\nStopped: ${stopped}\nRun the same command again to continue.`);
    process.exitCode = 3;
  }
} else {
  console.error("usage: tailor-eval run [options] | tailor-eval report <run folder>");
  process.exitCode = 2;
}
