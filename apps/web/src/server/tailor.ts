import "server-only";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { LLMError, createLLM, type ProviderId } from "@resume-studio/llm";
import {
  createTailorEngine,
  jobCompany,
  jobTitle,
  type Answer,
  type BuildCheck,
  type BuildVerifier,
  type JobInput,
  type Session,
  type SourceFiles,
  type TailorOptions,
} from "@resume-studio/tailor";
import { fileFactStore, fileSessionStore } from "@resume-studio/tailor/node";
import { latexAdapter } from "@resume-studio/tailor-latex";
import type { ResumeMeta } from "@/lib/types";
import { resolveProvider } from "./ai-config";
import { analyzePdf } from "./ats";
import { compileWithFallback } from "./compiler";
import { RESUMES_DIR, STATE_DIR } from "./config";
import { emit } from "./events";
import { HttpError, atomicWrite, slugify } from "./fsutil";
import { run } from "./run";
import { createSnapshot } from "./snapshots";
import { createResume, engineFor, getResume, listFiles, resumeDir, updateResume } from "./workspace";

// Resume Studio's use of the tailoring engine: sessions on disk, the fact bank next to your resumes,
// builds through the app's own compiler (so a draft is checked exactly like the editor checks your
// resume), and the result saved as a new resume.

const TAILOR_DIR = join(STATE_DIR, "tailor");
const SESSIONS_DIR = join(TAILOR_DIR, "sessions");
/** Your fact bank: true things about you the resume may not show. Plain JSON you can edit. */
export const FACTS_FILE = join(RESUMES_DIR, "_profile", "facts.json");

const sessionStore = fileSessionStore(SESSIONS_DIR);
const factStore = fileFactStore(FACTS_FILE);

/** Text files of a resume as engine source (LaTeX plus classes, packages, bibliographies). */
async function readSource(resumeId: string, meta: ResumeMeta): Promise<SourceFiles> {
  const dir = resumeDir(resumeId);
  const files: Record<string, string> = {};
  for (const f of await listFiles(resumeId)) {
    if (f.kind === "file" && /\.(tex|xtx|ltx|cls|sty|bib)$/.test(f.path) && f.size < 2_000_000) files[f.path] = await readFile(join(dir, f.path), "utf8");
  }
  return { main: meta.mainFile, files };
}

function workDir(sessionId: string) {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) throw new HttpError(400, "Invalid session id");
  return join(TAILOR_DIR, "work", sessionId);
}

// Builds that share a work folder (two quick preview requests) run one at a time: a second build would
// delete the sources the first is compiling.
const g0 = globalThis as unknown as { __rsTailorLocks?: Map<string, Promise<unknown>> };
const locks = (g0.__rsTailorLocks ??= new Map());

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  void next
    .finally(() => {
      if (locks.get(key) === next) locks.delete(key);
    })
    .catch(() => {});
  return next;
}

/**
 * Builds a draft with the app's compiler: the resume's non-text files (images, fonts) are copied in,
 * the draft's text files written over them, then compiled, measured (pages, overflow) and ATS-checked.
 */
function verifierFor(sessionId: string, resumeId: string, meta: ResumeMeta): BuildVerifier & { lastPdf: () => string | null } {
  let lastPdf: string | null = null;
  let n = 0;
  return {
    lastPdf: () => lastPdf,
    build: (source, opts) => serialized(workDir(sessionId), () => buildDraft(source, opts)),
    editAt: (draft, err) => latexAdapter.editAt(draft, err),
  };

  async function buildDraft(source: SourceFiles, { maxPages }: { maxPages?: number }): Promise<BuildCheck> {
    const base = workDir(sessionId);
    const src = join(base, "src");
    await rm(src, { recursive: true, force: true });
    await mkdir(src, { recursive: true });
    const dir = resumeDir(resumeId);
    for (const f of await listFiles(resumeId)) {
      if (f.kind !== "file" || f.path in source.files || f.path === "resume.json") continue;
      await mkdir(dirname(join(src, f.path)), { recursive: true });
      await copyFile(join(dir, f.path), join(src, f.path));
    }
    for (const [path, text] of Object.entries(source.files)) {
      await mkdir(dirname(join(src, path)), { recursive: true });
      await writeFile(join(src, path), text);
    }
    const engine = await engineFor(src, source.main, meta.engine);
    // force: the same draft built twice (the same edits previewed again) must still produce a PDF;
    // without it latexmk finds nothing changed and writes none.
    const raw = await compileWithFallback({ srcDir: src, outDir: join(base, "build"), mainFile: source.main, engine, trusted: meta.trusted, force: true });
    const errors = raw.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => ({ message: d.message, line: d.line ?? undefined, file: d.file ?? undefined }));
    if (!raw.pdfPath) return { ok: false, pages: null, errors: errors.length ? errors : [{ message: raw.startFailed ?? "The draft didn't compile" }] };
    // Unique per build: a preview copies its PDF out after the build, while the next one may be running.
    const pdf = join(base, `draft-${Date.now()}${++n}.pdf`);
    await copyFile(raw.pdfPath, pdf);
    lastPdf = pdf;
    const texts: Record<string, string> = Object.fromEntries(Object.entries(source.files).filter(([p]) => /\.(tex|cls|sty)$/.test(p)));
    const ats = await analyzePdf(pdf, texts, source.main).catch(() => null);
    const pages = ats && !ats.unavailable ? ats.stats.pages : null;
    let overflowLines: number | undefined;
    if (maxPages && pages && pages > maxPages) {
      const r = await run("pdftotext", ["-f", String(maxPages + 1), "-l", String(pages), "-enc", "UTF-8", pdf, "-"], { timeoutMs: 15_000 });
      overflowLines = r.stdout.split("\n").filter((l) => l.trim()).length;
    }
    return { ok: raw.ok || !errors.length, pages, overflowLines, text: ats?.text, atsScore: ats && !ats.unavailable ? ats.score : null, errors };
  }
}

/** A model client for a provider (the default one when not given), with a clear error when it isn't set up. */
export async function llmFor(provider?: ProviderId, model?: string) {
  try {
    return createLLM(await resolveProvider(provider, model ? { model } : undefined));
  } catch (e) {
    if (e instanceof LLMError) throw new HttpError(400, `${e.message}. Set it up under AI providers.`);
    throw e;
  }
}

async function engineSetup(session: { id?: string; resumeId: string; provider?: ProviderId; model?: string }) {
  const meta = await getResume(session.resumeId);
  const llm = await llmFor(session.provider, session.model);
  return {
    meta,
    llm,
    make: (id: string) =>
      createTailorEngine({
        llm,
        adapter: latexAdapter,
        verifier: verifierFor(id, session.resumeId, meta),
        store: sessionStore,
        facts: factStore,
        onEvent: (sid, e, s) => emit({ type: "tailor", sessionId: sid, resumeId: session.resumeId, status: s.status, message: e.message, step: e.step }),
      }),
  };
}

// Sessions run in the background; this tracks the ones in flight so they can be cancelled.
const g = globalThis as unknown as { __rsTailorRuns?: Map<string, AbortController> };
const running = (g.__rsTailorRuns ??= new Map());

async function runInBackground(sessionId: string) {
  if (running.has(sessionId)) return;
  // Registered before anything awaits: a page loading meanwhile must see it running, not interrupted.
  const ctl = new AbortController();
  running.set(sessionId, ctl);
  let engine: ReturnType<Awaited<ReturnType<typeof engineSetup>>["make"]>;
  try {
    const s = await sessionStore.get(sessionId);
    if (!s) throw new HttpError(404, "No such session");
    const { make } = await engineSetup({ resumeId: s.context.resumeId, provider: s.context.provider as ProviderId, model: s.context.model });
    engine = make(sessionId);
  } catch (e) {
    running.delete(sessionId);
    throw e;
  }
  void engine
    .run(sessionId, ctl.signal)
    .catch((e) => console.error("[tailor]", e))
    .finally(() => running.delete(sessionId));
}

// ---- Public API -------------------------------------------------------------------------------------------

export interface StartTailoring {
  resumeId: string;
  job: JobInput;
  options?: TailorOptions;
  provider?: ProviderId;
  model?: string;
}

export async function startTailoring(input: StartTailoring): Promise<Session> {
  const { meta, llm, make } = await engineSetup(input);
  const source = await readSource(input.resumeId, meta);
  const engine = make("pending");
  const s = await engine.start({
    job: input.job,
    source,
    options: input.options,
    context: { resumeId: input.resumeId, provider: llm.provider, model: llm.model, resumeName: meta.name },
  });
  await runInBackground(s.id);
  return s;
}

const WORKING = new Set<Session["status"]>(["created", "analyzing", "writing", "verifying"]);

/**
 * A session that says it's working while nothing runs it was cut off (the app restarted mid-run). It
 * resumes from its last finished step when you ask (retrySession); it isn't restarted on its own, since
 * that would spend model usage without you asking.
 */
const isInterrupted = (s: Session) => WORKING.has(s.status) && !running.has(s.id);

export async function getSession(id: string): Promise<Session & { running: boolean; interrupted: boolean }> {
  const s = await sessionStore.get(id);
  if (!s) throw new HttpError(404, "No such tailoring session");
  return { ...s, running: running.has(id), interrupted: isInterrupted(s) };
}

export async function listSessions(
  resumeId?: string,
): Promise<(Pick<Session, "id" | "status" | "createdAt" | "updatedAt" | "job" | "context"> & { interrupted: boolean; fit?: Session["fit"] })[]> {
  void pruneOnce();
  const files = await readdir(SESSIONS_DIR).catch(() => [] as string[]);
  const out = [];
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    const s = await sessionStore.get(f.replace(/\.json$/, ""));
    if (!s || (resumeId && s.context.resumeId !== resumeId)) continue;
    out.push({
      id: s.id,
      status: s.status,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      job: s.job,
      context: s.context,
      interrupted: isInterrupted(s),
      fit: s.fit,
    });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function answerSession(id: string, answers: Answer[]) {
  const s = await getSession(id);
  const { make } = await engineSetup({ resumeId: s.context.resumeId, provider: s.context.provider as ProviderId, model: s.context.model });
  await make(id).answer(id, answers);
  await runInBackground(id);
}

/** Runs again after a failure or cancel; finished steps are kept. */
export async function retrySession(id: string) {
  const s = await getSession(id);
  const { make } = await engineSetup({ resumeId: s.context.resumeId, provider: s.context.provider as ProviderId, model: s.context.model });
  await make(id).retry(id);
  await runInBackground(id);
}

export async function cancelSession(id: string) {
  const ctl = running.get(id);
  if (ctl) return ctl.abort();
  // Nothing running it (interrupted): mark it cancelled directly.
  const s = await sessionStore.get(id);
  if (s && WORKING.has(s.status)) {
    s.status = "cancelled";
    s.updatedAt = new Date().toISOString();
    await sessionStore.put(s);
    emit({ type: "tailor", sessionId: id, resumeId: s.context.resumeId, status: s.status, message: "Cancelled" });
  }
}

/** Builds a draft with only these edits, for the review screen. Returns the preview's id. */
export async function previewSession(
  id: string,
  accepted: string[],
): Promise<{ pdf: string; pages: number | null; atsScore: number | null; errors: string[] }> {
  const s = await getSession(id);
  const { make, meta } = await engineSetup({ resumeId: s.context.resumeId, provider: s.context.provider as ProviderId, model: s.context.model });
  const source = await make(id).preview(id, accepted);
  const v = verifierFor(`${id}-preview`, s.context.resumeId, meta);
  const check = await v.build(source, {});
  const pdf = v.lastPdf();
  if (!pdf) return { pdf: "", pages: null, atsScore: null, errors: check.errors.map((e) => e.message) };
  const name = `preview-${Date.now()}.pdf`;
  await copyFile(pdf, join(workDir(id), name));
  await keepNewestPdfs(workDir(id));
  await keepNewestPdfs(workDir(`${id}-preview`));
  return { pdf: name, pages: check.pages, atsScore: check.atsScore ?? null, errors: check.errors.map((e) => e.message) };
}

export function previewPath(id: string, name: string) {
  if (!/^(preview|draft)-\d+\.pdf$/.test(name)) throw new HttpError(400, "Invalid preview");
  return join(workDir(id), name);
}

/**
 * Saves the accepted edits as a new resume next to the original, with the job description and the
 * session's record beside it, and a labelled snapshot.
 */
export async function finalizeSession(id: string, accepted: string[], name: string): Promise<ResumeMeta> {
  const s = await getSession(id);
  const { make } = await engineSetup({ resumeId: s.context.resumeId, provider: s.context.provider as ProviderId, model: s.context.model });
  const { source } = await make(id).finalize(id, accepted);
  const created = await createResume({ name, duplicateOf: s.context.resumeId });
  const dir = resumeDir(created.id);
  for (const [path, text] of Object.entries(source.files)) await atomicWrite(join(dir, path), text);
  await atomicWrite(join(dir, "jd.md"), `# ${jobTitle(s.job)} — ${jobCompany(s.job)}\n\n${s.job.link ? `${s.job.link}\n\n` : ""}${s.job.description.trim()}\n`);
  await atomicWrite(
    join(dir, "tailor.json"),
    JSON.stringify(
      {
        session: s.id,
        job: s.job,
        options: s.options,
        strategy: s.strategy,
        accepted,
        edits: s.edits,
        report: s.report
          ? {
              ...s.report,
              before: { ...s.report.before, build: { ...s.report.before.build, text: undefined } },
              after: { ...s.report.after, build: { ...s.report.after.build, text: undefined } },
            }
          : undefined,
        provenance: s.provenance,
        usage: s.usage,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  const meta = await updateResume(created.id, {
    application: {
      company: jobCompany(s.job),
      role: jobTitle(s.job),
      link: s.job.link,
      baseResume: s.context.resumeId,
      session: s.id,
      createdAt: new Date().toISOString(),
      status: "draft",
    },
  });
  await createSnapshot(created.id, {
    message: `Tailored for ${jobCompany(s.job)}: ${jobTitle(s.job)}`,
    label: slugify(`${s.job.company || "job"}-${jobTitle(s.job)}`).slice(0, 50),
  }).catch(() => null);
  emit({ type: "resumes" });
  // The build folders served the review; reopening it rebuilds what it needs.
  await rm(workDir(id), { recursive: true, force: true });
  await rm(workDir(`${id}-preview`), { recursive: true, force: true });
  return meta;
}

export async function readFacts() {
  return factStore.list();
}

export async function writeFacts(facts: { id: string; text: string; skills: string[]; source: "answer" | "manual" | "import"; createdAt: string }[]) {
  await atomicWrite(FACTS_FILE, JSON.stringify({ facts }, null, 2) + "\n");
}

export function factsFileExists() {
  return existsSync(FACTS_FILE);
}

// ---- Housekeeping -----------------------------------------------------------------------------------------

/** Sessions untouched this long are removed, with their work folders. A saved resume keeps its own record (tailor.json). */
const SESSION_TTL_MS = 30 * 86_400_000;
/** Preview and draft PDFs kept per work folder; the review screen only shows the latest. */
const KEEP_PDFS = 3;

async function keepNewestPdfs(dir: string) {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => /^(preview|draft)-\d+\.pdf$/.test(n));
  const dated = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(dir, n)).catch(() => null))?.mtimeMs ?? 0 })));
  const old = dated.sort((a, b) => b.t - a.t).slice(KEEP_PDFS);
  await Promise.all(old.map(({ n }) => rm(join(dir, n), { force: true })));
}

/** Removes expired sessions, the work folders of finished or orphaned ones, and old PDFs. */
export async function pruneTailorState(now = Date.now()) {
  const ids = new Set<string>();
  for (const f of await readdir(SESSIONS_DIR).catch(() => [] as string[])) {
    if (!f.endsWith(".json")) continue;
    const s = await sessionStore.get(f.replace(/\.json$/, ""));
    if (!s || running.has(s.id)) {
      if (s) ids.add(s.id);
      continue;
    }
    if (now - Date.parse(s.updatedAt) > SESSION_TTL_MS) {
      await rm(join(SESSIONS_DIR, f), { force: true });
      continue;
    }
    ids.add(s.id);
  }
  const workRoot = join(TAILOR_DIR, "work");
  for (const d of await readdir(workRoot).catch(() => [] as string[])) {
    const owner = d.replace(/-preview$/, "");
    if (!ids.has(owner)) await rm(join(workRoot, d), { recursive: true, force: true });
    else await keepNewestPdfs(join(workRoot, d));
  }
}

const gp = globalThis as unknown as { __rsTailorPruned?: Promise<void> };
/** Once per server process, in the background. */
function pruneOnce() {
  return (gp.__rsTailorPruned ??= pruneTailorState().catch((e) => console.error("[tailor] prune", e)));
}
