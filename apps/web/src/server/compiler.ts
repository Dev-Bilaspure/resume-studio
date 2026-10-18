import "server-only";
import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  BUILTIN_LATEXMKRC,
  PROJECT_RC_FILES,
  TexServiceError,
  folderEntries,
  jobName,
  latexmkInvocation,
  type CompileResponse,
} from "@resume-studio/tex-service";
import type { BuildResult, BuildState, Diagnostic, Engine } from "@/lib/types";
import { analyzePdf, readSources } from "./ats";
import { BUILD_DIR, COMPILE_TIMEOUT_MS, KEEP_BUILDS, PUBLISH_DIR, STATE_DIR, findTool } from "./config";
import { emit } from "./events";
import { isJunk, sha256 } from "./fsutil";
import { needsXeTeX, requestedFonts } from "./engine";
import { attributeToUsepackage, parseBibLog, parseLog } from "./logparser";
import { missingMacFonts } from "./macfonts";
import { run } from "./run";
import { releaseBuildDir, serviceProject, texService, toolchainMode } from "./toolchain";
import { META_FILE, getResume, listFiles, projectPreamble, resumeDir, textFiles } from "./workspace";

/** Rules every build loads (glossaries, nomenclature, dvipdfmx), written where latexmk can read them. */
const BUILTIN_RC = join(STATE_DIR, "latexmkrc");
let rcWritten: Promise<void> | null = null;
function ensureBuiltinRc() {
  return (rcWritten ??= (async () => {
    await mkdir(STATE_DIR, { recursive: true });
    if ((await readFile(BUILTIN_RC, "utf8").catch(() => null)) !== BUILTIN_LATEXMKRC) await writeFile(BUILTIN_RC, BUILTIN_LATEXMKRC);
  })().catch((e) => {
    rcWritten = null;
    throw e;
  }));
}

export interface RawCompile {
  ok: boolean;
  timedOut: boolean;
  startFailed: string | null;
  pdfPath: string | null; // only a PDF written by this run
  synctexPath: string | null;
  diagnostics: Diagnostic[];
  outputTail: string;
}

/**
 * One latexmk run. latexmk reruns the engine, bibtex/biber and makeindex until cross-references settle,
 * and reuses the aux files in `outDir` from the previous build, so later builds are incremental.
 */
export interface CompileOptions {
  srcDir: string;
  /**
   * The build folder: a mirror of srcDir where TeX runs and writes its output, the way Overleaf's
   * compile servers work. Every path TeX and its helpers see is relative (TeX's openout_any=p write
   * protection stays on, and makeindex/makeglossaries/epstopdf work), and generated files never land
   * in your source folder.
   */
  outDir: string;
  mainFile: string;
  engine: Engine;
  force?: boolean;
  /** -shell-escape and the project's latexmkrc. Untrusted builds get TeX's restricted shell escape. */
  trusted?: boolean;
  haltOnError?: boolean;
  /** Preamble and project .cls/.sty text, for predicting fonts XeLaTeX on macOS can't find. */
  fontSources?: string;
}

/** latexmk's exit, from wherever it ran; its outputs are then in the build folder. */
interface LatexmkRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Couldn't start the build: no TeX, or the compile service is unreachable. */
  startFailed: string | null;
  /** Notes about the build itself (fonts swapped for stand-ins). */
  notes: Diagnostic[];
}

export async function compileDir(opts: CompileOptions): Promise<RawCompile> {
  // Like Overleaf (latexmk -cd), TeX runs in the main file's folder: a main file in examples/ finds
  // examples/awesome-cv.cls and \input{cv/education} relative to itself.
  const mainDir = dirname(opts.mainFile);
  const cwd = join(/*turbopackIgnore: true*/ opts.outDir, mainDir);
  const base = jobName(opts.mainFile);
  const out = (ext: string) => join(/*turbopackIgnore: true*/ cwd, `${base}.${ext}`);
  const started = Date.now();

  const res = toolchainMode() === "service" ? await latexmkOnService(opts, cwd, base) : await latexmkHere(opts, cwd);
  if (res.startFailed) {
    return { ok: false, timedOut: false, startFailed: res.startFailed, pdfPath: null, synctexPath: null, diagnostics: [], outputTail: "" };
  }

  const log = await readFile(out("log"), "utf8").catch(() => "");
  // Paths in the log are the mirror's, which match the source folder's layout.
  const diagnostics = [
    ...res.notes,
    ...attributeToUsepackage(
    [
      ...parseLog(log, { rootDir: opts.outDir, cwd: mainDir }),
      ...parseBibLog(await readFile(out("blg"), "utf8").catch(() => ""), { rootDir: opts.outDir, cwd: mainDir }),
    ],
      await readSourcesIn(opts.srcDir, opts.mainFile),
    ),
  ];
  // A PDF from an earlier build is still in outDir when this one fails before writing; only trust a
  // complete PDF written during this run.
  const pdf = out("pdf");
  const pdfFresh = (await stat(pdf).catch(() => null))?.mtimeMs ?? 0;
  const pdfOk = pdfFresh >= started - 1000 && (await isCompletePdf(pdf));
  const synctex = out("synctex.gz");
  const hasErrors = diagnostics.some((d) => d.severity === "error");
  const tail = (res.stdout + "\n" + res.stderr)
    .split("\n")
    .filter((l) => l.trim())
    .slice(-40)
    .join("\n");

  if (res.timedOut) {
    diagnostics.unshift({
      severity: "error",
      kind: "other",
      file: null,
      line: null,
      message: `Compilation was stopped after ${COMPILE_TIMEOUT_MS / 1000}s`,
      detail: "Usually an endless loop in a macro, or TeX waiting for input. Check the most recent edit.",
    });
  } else if (!hasErrors && res.code !== 0) {
    diagnostics.unshift({
      severity: "error",
      kind: "other",
      file: null,
      line: null,
      message: "latexmk failed",
      detail: tail.split("\n").slice(-8).join("\n"),
    });
  }

  return {
    ok: !res.timedOut && res.code === 0 && pdfOk && !hasErrors,
    timedOut: res.timedOut,
    startFailed: null,
    pdfPath: pdfOk ? pdf : null,
    synctexPath: pdfOk && existsSync(synctex) ? synctex : null,
    diagnostics,
    outputTail: tail,
  };
}

/** latexmk on this machine, in a mirror of the sources (see mirrorSources). */
async function latexmkHere(opts: CompileOptions, cwd: string): Promise<LatexmkRun> {
  const latexmk = findTool("latexmk");
  if (!latexmk) {
    const fail = "TeX isn't installed (latexmk not found). Start the compile service with `docker compose up -d` (or install MacTeX: brew install --cask mactex-no-gui), then recompile.";
    return { code: null, stdout: "", stderr: "", timedOut: false, startFailed: fail, notes: [] };
  }
  await mkdir(opts.outDir, { recursive: true });
  await mirrorSources(opts.srcDir, opts.outDir);
  await ensureBuiltinRc();
  const { args, env } = latexmkInvocation({
    engine: opts.engine,
    mainFile: basename(opts.mainFile),
    force: opts.force,
    trusted: opts.trusted,
    haltOnError: opts.haltOnError,
    builtinRc: BUILTIN_RC,
    projectRcs: PROJECT_RC_FILES.filter((f) => existsSync(join(/*turbopackIgnore: true*/ opts.srcDir, f))).map((f) => join(/*turbopackIgnore: true*/ opts.outDir, f)),
  });
  const res = await run(latexmk, args, { cwd, timeoutMs: COMPILE_TIMEOUT_MS, env });
  if (res.error) return { code: null, stdout: "", stderr: "", timedOut: false, startFailed: `Couldn't run latexmk: ${res.error.message}`, notes: [] };
  return { code: res.code, stdout: res.stdout, stderr: res.stderr, timedOut: res.timedOut, startFailed: null, notes: [] };
}

/** A source folder's files as the compile service gets them: what mirrorSources copies for a local build. */
export function serviceSources(srcDir: string) {
  return folderEntries(srcDir, (_path, name) => !isJunk(name) && name !== ".git" && name !== META_FILE && !name.startsWith("."));
}

/**
 * latexmk on the compile service: uploads what changed, builds there, and writes what the build produced
 * (log, .blg, PDF, SyncTeX) into the build folder, so everything after this reads them as from a local build.
 */
async function latexmkOnService(opts: CompileOptions, cwd: string, base: string): Promise<LatexmkRun> {
  const service = texService();
  const project = serviceProject(opts.outDir);
  let r: CompileResponse;
  try {
    await service.sync(project, await serviceSources(opts.srcDir));
    r = await service.compile(project, {
      main: opts.mainFile,
      engine: opts.engine,
      force: opts.force,
      trusted: opts.trusted,
      haltOnError: opts.haltOnError,
      timeoutMs: COMPILE_TIMEOUT_MS,
    });
  } catch (e) {
    if (e instanceof TexServiceError) return { code: null, stdout: "", stderr: "", timedOut: false, startFailed: e.message, notes: [] };
    throw e;
  }
  // Paths in the log name the service's folder; the log parser expects the build folder's.
  const local = (text: string) => text.replaceAll(`${r.root}/`, `${opts.outDir}/`);
  await mkdir(cwd, { recursive: true });
  const put = async (ext: string, data: string | null, enc: "utf8" | "base64") => {
    if (data !== null) await writeFile(join(/*turbopackIgnore: true*/ cwd, `${base}.${ext}`), enc === "utf8" ? local(data) : Buffer.from(data, "base64"));
  };
  await Promise.all([put("log", r.log, "utf8"), put("blg", r.blg, "utf8"), put("pdf", r.pdf, "base64"), put("synctex.gz", r.synctex, "base64")]);
  const notes: Diagnostic[] = r.substitutions.map(({ from, to }) => ({
    severity: "info",
    kind: "font",
    file: null,
    line: null,
    message: `Built with ${to} in place of ${from}`,
    detail: `${from} isn't available in the compile service (it's a commercial font). ${to} has the same character widths, so lines and pages break the same way; the letters look slightly different. Your file still says ${from}.`,
  }));
  return { code: r.code, stdout: local(r.stdout), stderr: local(r.stderr), timedOut: r.timedOut, startFailed: null, notes };
}

const MIRROR_MANIFEST = ".resume-studio-mirror.json";

/**
 * Brings the build folder's copy of the sources up to date: copies new and changed files, deletes the
 * copies of files you've deleted, and leaves everything TeX generated alone.
 */
export async function mirrorSources(srcDir: string, workDir: string) {
  const manifestPath = join(workDir, MIRROR_MANIFEST);
  const before: Record<string, string> = JSON.parse(await readFile(manifestPath, "utf8").catch(() => "{}"));
  const now: Record<string, string> = {};
  async function walk(rel: string) {
    const dir = join(srcDir, rel);
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (isJunk(e.name) || e.name === ".git" || e.name === META_FILE) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!e.name.startsWith(".")) await walk(r);
      } else if (e.isFile()) {
        const st = await stat(join(srcDir, r));
        const sig = `${st.size}:${st.mtimeMs}`;
        now[r] = sig;
        if (before[r] !== sig || !existsSync(join(workDir, r))) {
          await mkdir(dirname(join(workDir, r)), { recursive: true });
          await copyFile(join(srcDir, r), join(workDir, r));
        }
      }
    }
  }
  await walk("");
  for (const r of Object.keys(before)) if (!(r in now)) await rm(join(workDir, r), { force: true });
  await writeFile(manifestPath, JSON.stringify(now));
}

/** The main file's source (the preamble is where packages are loaded). */
async function readSourcesIn(srcDir: string, mainFile: string): Promise<Record<string, string>> {
  const src = await readFile(join(/*turbopackIgnore: true*/ srcDir, mainFile), "utf8").catch(() => null);
  return src === null ? {} : { [mainFile]: src };
}

const MISSING_FONT = /Font .*?=\s*"?([^"=]+?)"?\s+at [\d.]+pt not loadable: Metric \(TFM\) file or installed font not found|The font "([^"]+)" cannot be found/;

/**
 * XeLaTeX on macOS finds fonts by name only among fonts installed in macOS, never the ones that ship
 * with TeX Live (Roboto, Source Sans 3, Lato, Fira…). On Overleaf's Linux servers it sees both, which
 * is why CV templates that ask for those fonts by name build there. LuaLaTeX finds TeX Live's fonts on
 * every system, so when a XeLaTeX build fails only for that reason, it is rebuilt with LuaLaTeX.
 */
export async function compileWithFallback(opts: CompileOptions, memo: { xeLua: boolean } = { xeLua: false }): Promise<RawCompile & { engine: Engine }> {
  const note = (fonts: string[]): Diagnostic => ({
    severity: "info",
    kind: "font",
    file: null,
    line: null,
    message: "Built with LuaLaTeX instead of XeLaTeX",
    detail: `XeLaTeX on macOS only finds fonts installed in macOS (Font Book)${fonts.length ? `, so it couldn't load ${fonts.join(", ")}` : ""}, which come with TeX Live. LuaLaTeX finds TeX Live's fonts, and Overleaf's XeLaTeX finds them too. To build with XeLaTeX here, install those fonts in macOS.`,
  });
  // Only TeX on macOS has this problem: the compile service runs Linux TeX Live, like Overleaf.
  if (opts.engine !== "xelatex" || process.platform !== "darwin" || toolchainMode() === "service") return { ...(await compileDir(opts)), engine: opts.engine };
  // Predict instead of finding out: a XeLaTeX pass that looks up missing fonts takes ~3 s per font
  // (AltaCV: 12 fonts, 34 s a pass). If the document asks for fonts macOS doesn't have, go straight
  // to LuaLaTeX.
  // XeTeX-only packages (xltxtra, xunicode, xeCJK…) rule LuaLaTeX out.
  const luaPossible = !!findTool("lualatex") && !needsXeTeX(opts.fontSources ?? "");
  if (!memo.xeLua && luaPossible && opts.fontSources) {
    const missing = await missingMacFonts(requestedFonts(opts.fontSources)).catch(() => null);
    if (missing?.length) {
      const lua = await compileDir({ ...opts, engine: "lualatex" });
      if (lua.ok) {
        memo.xeLua = true;
        return { ...lua, engine: "lualatex", diagnostics: [note(missing), ...lua.diagnostics] };
      }
      // LuaLaTeX didn't fully work either (a font neither has, or something engine-specific): build
      // with XeLaTeX as asked, and keep whichever result has fewer errors.
      const xe = await compileDir({ ...opts, force: true });
      const errs = (r: RawCompile) => r.diagnostics.filter((d) => d.severity === "error").length;
      if (xe.ok || errs(xe) <= errs(lua)) return { ...xe, engine: "xelatex" };
      return { ...lua, engine: "lualatex", diagnostics: [note(missing), ...lua.diagnostics] };
    }
  }
  if (memo.xeLua && luaPossible) {
    const raw = await compileDir({ ...opts, engine: "lualatex" });
    return { ...raw, engine: "lualatex", diagnostics: [note([]), ...raw.diagnostics] };
  }
  const xe = await compileDir(opts);
  const missing = [
    ...new Set(
      xe.diagnostics
        .map((d) => MISSING_FONT.exec(d.message) ?? MISSING_FONT.exec(d.detail ?? ""))
        .filter((m) => !!m)
        .map((m) => (m[1] ?? m[2]).trim()),
    ),
  ];
  if (xe.ok || !missing.length || !luaPossible) return { ...xe, engine: "xelatex" };
  const lua = await compileDir({ ...opts, engine: "lualatex", force: true });
  const better = lua.ok || lua.diagnostics.filter((d) => d.severity === "error").length < xe.diagnostics.filter((d) => d.severity === "error").length;
  if (!better) return { ...xe, engine: "xelatex" };
  memo.xeLua = true;
  return { ...lua, engine: "lualatex", diagnostics: [note(missing), ...lua.diagnostics] };
}

/** A PDF is complete when its trailer (%%EOF) has been written. */
async function isCompletePdf(path: string): Promise<boolean> {
  try {
    const fh = await open(path, "r");
    try {
      const { size } = await fh.stat();
      if (size < 64) return false;
      const len = Math.min(2048, size);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      return buf.toString("latin1").includes("%%EOF");
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/** Copy, then rename into place: the PDF route never serves a half-copied file. */
async function publishFile(src: string, dest: string) {
  const tmp = `${dest}.tmp`;
  await copyFile(src, tmp);
  await rename(tmp, dest);
}

function countPages(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length || 1;
}

// ---- Per-resume build queue ------------------------------------------------------------------------------

type Listener = (r: BuildResult) => void;

class ResumeCompiler {
  private running: Promise<void> | null = null;
  private pending = false;
  private force = false;
  private lastFingerprint: string | null = null;
  private fontMemo = { xeLua: false };
  private fontMemoEngine: Engine | null = null;
  last: BuildResult | null = null;
  lastGood: BuildResult | null = null;
  private listeners = new Set<Listener>();

  constructor(private id: string) {}

  /** Restores the last results after a server restart, so the preview shows immediately. */
  async load() {
    try {
      const saved = JSON.parse(await readFile(join(PUBLISH_DIR, this.id, "state.json"), "utf8")) as {
        last: BuildResult | null;
        lastGood: BuildResult | null;
        /** Remembered: this resume's XeLaTeX build needs the LuaLaTeX font fallback. */
        fontFallback?: { engine: Engine; xeLua: boolean };
      };
      if (saved.fontFallback) {
        this.fontMemo = { xeLua: saved.fontFallback.xeLua };
        this.fontMemoEngine = saved.fontFallback.engine;
      }
      const exists = (r: BuildResult | null) => (r?.pdfUrl ? existsSync(join(PUBLISH_DIR, this.id, `${r.id}.pdf`)) : true);
      this.last = exists(saved.last) ? saved.last : null;
      this.lastGood = saved.lastGood && exists(saved.lastGood) ? saved.lastGood : null;
    } catch {
      // Never built.
    }
  }

  state(): BuildState {
    return { resumeId: this.id, running: this.running !== null, last: this.last, lastGood: this.lastGood };
  }

  onBuild(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Requests a build. While one runs, further requests coalesce into a single follow-up build of the
   * newest files: a burst of saves never queues a backlog, and a build is never killed half-way (which
   * can leave corrupt aux files behind).
   */
  schedule(force = false) {
    this.force ||= force;
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
    });
  }

  /** "Clear cached files": drops the aux files (stale or corrupt ones can break a build), then rebuilds. */
  async clean() {
    await this.idle();
    await releaseBuildDir(join(BUILD_DIR, this.id));
    this.schedule(true);
  }

  /** Resolves when the current (and any coalesced) build is done. */
  async idle() {
    while (this.running) await this.running;
  }

  private async loop() {
    do {
      this.pending = false;
      const force = this.force;
      this.force = false;
      // Saving from the editor and the file watcher both ask for a build; skip it if nothing changed.
      const fp = await this.fingerprint();
      if (!force && fp === this.lastFingerprint && this.last) continue;
      this.lastFingerprint = fp;
      await this.build(force);
    } while (this.pending);
  }

  private async fingerprint(): Promise<string> {
    const files = await listFiles(this.id).catch(() => []);
    const meta = await getResume(this.id).catch(() => null);
    return sha256(JSON.stringify([meta?.engine, meta?.mainFile, meta?.trusted, meta?.haltOnError, files.map((f) => [f.path, f.size, f.mtimeMs])]));
  }

  private async build(force: boolean) {
    const buildId = nextBuildId();
    const startedAt = Date.now();
    emit({ type: "build-start", resumeId: this.id, buildId });

    let result: BuildResult;
    try {
      const meta = await getResume(this.id);
      const srcDir = resumeDir(this.id);
      // getResume already resolved the engine the document needs (see engineFor).
      const engine = meta.engine;
      // A changed engine setting retries XeLaTeX; otherwise keep using the LuaLaTeX fallback once it was needed.
      if (this.fontMemoEngine !== engine) {
        this.fontMemo = { xeLua: false };
        this.fontMemoEngine = engine;
      }
      const { main, related } = engine === "xelatex" ? await projectPreamble(srcDir, meta.mainFile) : { main: "", related: [] };
      const raw = await compileWithFallback(
        {
          srcDir,
          outDir: join(BUILD_DIR, this.id),
          mainFile: meta.mainFile,
          engine,
          force,
          trusted: meta.trusted,
          haltOnError: meta.haltOnError,
          fontSources: [main, ...related].join("\n"),
        },
        this.fontMemo,
      );

      const pub = join(PUBLISH_DIR, this.id);
      await mkdir(pub, { recursive: true });
      let url: string | null = null;
      let pages: number | null = null;
      if (raw.pdfPath) {
        await publishFile(raw.pdfPath, join(pub, `${buildId}.pdf`));
        if (raw.synctexPath) await publishFile(raw.synctexPath, join(pub, `${buildId}.synctex.gz`));
        url = `/api/resumes/${encodeURIComponent(this.id)}/pdf/${buildId}`;
        pages = countPages(await readFile(join(pub, `${buildId}.pdf`)));
      }
      const ats =
        raw.ok && raw.pdfPath
          ? await analyzePdf(join(pub, `${buildId}.pdf`), await readSources(await textFiles(this.id)), meta.mainFile).catch(() => null)
          : null;

      const startFailed: BuildResult["diagnostics"] = raw.startFailed
        ? [{ severity: "error", kind: "other", file: null, line: null, message: raw.startFailed }]
        : [];
      result = {
        id: buildId,
        resumeId: this.id,
        status: raw.startFailed ? "failed-to-start" : raw.timedOut ? "timeout" : raw.ok ? "ok" : "error",
        pdfUrl: raw.ok ? url : null,
        partialPdfUrl: raw.ok ? null : url,
        startedAt,
        durationMs: Date.now() - startedAt,
        engine: raw.engine,
        pages: ats && !ats.unavailable ? ats.stats.pages : pages,
        diagnostics: [...startFailed, ...raw.diagnostics],
        outputTail: raw.outputTail,
        ats,
      };
    } catch (e) {
      result = {
        id: buildId,
        resumeId: this.id,
        status: "error",
        pdfUrl: null,
        partialPdfUrl: null,
        startedAt,
        durationMs: Date.now() - startedAt,
        pages: null,
        diagnostics: [{ severity: "error", kind: "other", file: null, line: null, message: `Build failed: ${(e as Error).message}` }],
        outputTail: "",
        ats: null,
      };
    }

    this.last = result;
    if (result.status === "ok") this.lastGood = result;
    await this.persist();
    await this.prune();
    emit({ type: "build", result });
    for (const fn of this.listeners) fn(result);
  }

  private async persist() {
    const dir = join(PUBLISH_DIR, this.id);
    await mkdir(dir, { recursive: true });
    const fontFallback = this.fontMemoEngine ? { engine: this.fontMemoEngine, xeLua: this.fontMemo.xeLua } : undefined;
    await writeFile(join(dir, "state.json.tmp"), JSON.stringify({ last: this.last, lastGood: this.lastGood, fontFallback }));
    await rename(join(dir, "state.json.tmp"), join(dir, "state.json"));
  }

  /** Keeps the newest builds and the last good one; the viewer may still be loading a recent one. */
  private async prune() {
    const dir = join(PUBLISH_DIR, this.id);
    const ids = [
      ...new Set(
        (await readdir(dir).catch(() => []))
          .map((f) => /^(\d+)\.(pdf|synctex\.gz)$/.exec(f)?.[1])
          .filter((x): x is string => !!x)
          .map(Number),
      ),
    ].sort((a, b) => b - a);
    const keep = new Set([...ids.slice(0, KEEP_BUILDS), this.lastGood?.id, this.last?.id]);
    for (const id of ids) {
      if (keep.has(id)) continue;
      await rm(join(dir, `${id}.pdf`), { force: true });
      await rm(join(dir, `${id}.synctex.gz`), { force: true });
    }
  }
}

// Build ids increase across restarts (seeded from the clock), so a cached URL never points at a new PDF.
let lastBuildId = 0;
function nextBuildId() {
  lastBuildId = Math.max(lastBuildId + 1, Math.floor(Date.now() / 10));
  return lastBuildId;
}

// One compiler per resume per process, kept on globalThis. In development, a code change re-evaluates
// this module: compilers made by the old code are replaced (their state reloads from state.json), so
// fixes apply without restarting the server.
const MODULE_VERSION = Math.random();
const g = globalThis as unknown as { __rsCompilerCache?: Map<string, { version: number; compiler: Promise<ResumeCompiler> }> };
const compilers = (g.__rsCompilerCache ??= new Map());

export function getCompiler(id: string): Promise<ResumeCompiler> {
  resumeDir(id); // validates the id
  const cached = compilers.get(id);
  if (cached?.version === MODULE_VERSION) return cached.compiler;
  // Let a build started by the old code finish before the new compiler reads its state.
  const previous: Promise<ResumeCompiler> | undefined = cached?.compiler;
  const inst = new ResumeCompiler(id);
  const compiler = (previous ? previous.then((old) => old.idle()).catch(() => {}) : Promise.resolve()).then(() => inst.load()).then(() => inst);
  compilers.set(id, { version: MODULE_VERSION, compiler });
  return compiler;
}

export function dropCompiler(id: string) {
  compilers.delete(id);
}

export function publishedPath(id: string, buildId: number, ext: "pdf" | "synctex.gz") {
  return join(/*turbopackIgnore: true*/ PUBLISH_DIR, id, `${buildId}.${ext}`);
}
