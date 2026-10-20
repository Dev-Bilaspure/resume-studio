import "server-only";
import { watch, type FSWatcher } from "chokidar";
import { relative, sep } from "node:path";
import { TEX_ENGINES } from "@resume-studio/tex-service";
import type { Engine, SystemStatus } from "@/lib/types";
import { atsToolsMissing } from "./ats";
import { RESUMES_DIR, ROOT, findTool } from "./config";
import { getCompiler } from "./compiler";
import { emit } from "./events";
import { isJunk, toPosix } from "./fsutil";
import { run } from "./run";
import { serviceInfo, texService, toolchainMode } from "./toolchain";
import { maybeAutoSnapshot } from "./snapshots";
import { ID_RE, META_FILE, ensureDirs, hashOnDisk } from "./workspace";

// Process-wide services, started on the first request: the file watcher that rebuilds on any change
// under resumes/ (from this app or any other editor) and auto-snapshots after good builds.

const g = globalThis as unknown as {
  __rsRuntime?: Promise<void>;
  __rsWatcher?: FSWatcher;
  /** The current code's change handler; the long-lived watcher calls through this. */
  __rsOnChange?: (event: string, abs: string) => void;
  /** Set on watchers that call through __rsOnChange. */
  __rsWatcherDelegates?: boolean;
};

// A watcher started by older code (before it delegated to __rsOnChange) is replaced once.
if (g.__rsWatcher && !g.__rsWatcherDelegates) {
  void g.__rsWatcher.close();
  g.__rsWatcher = undefined;
  g.__rsRuntime = undefined;
}

export function ensureRuntime(): Promise<void> {
  return (g.__rsRuntime ??= start().catch((e) => {
    g.__rsRuntime = undefined;
    throw e;
  }));
}

// File changes are batched (editors write several files, or one file several times) and then each
// changed resume is rebuilt. This state and handler belong to the current module evaluation: in
// development a code change re-evaluates this file and installs the new handler below, while the one
// watcher keeps running, so a reload never leaves file-triggered builds on old code.
const pending = new Map<string, Set<string>>(); // resume id → changed paths
let timer: NodeJS.Timeout | null = null;
let resumesChanged = false;

async function flush() {
  timer = null;
  const batch = [...pending.entries()];
  pending.clear();
  if (resumesChanged) {
    resumesChanged = false;
    emit({ type: "resumes" });
  }
  for (const [id, paths] of batch) {
    const changes = await Promise.all([...paths].map(async (p) => ({ path: p, hash: p ? await hashOnDisk(`${RESUMES_DIR}/${id}/${p}`) : null })));
    emit({ type: "files", resumeId: id, changes: changes.filter((c) => c.path) });
    if ([...paths].some((p) => p === META_FILE)) emit({ type: "resumes" });
    (await compilerFor(id).catch(() => null))?.schedule();
  }
}

function onChange(event: string, abs: string) {
  const rel = toPosix(relative(RESUMES_DIR, abs));
  if (!rel || rel.startsWith("..")) return;
  const [id, ...rest] = rel.split("/");
  if (!ID_RE.test(id) || id.startsWith("_")) return;
  const path = rest.join("/");
  if (isJunk(rest.at(-1) ?? "")) return;
  if (!path && (event === "addDir" || event === "unlinkDir")) {
    resumesChanged = true;
  } else {
    const set = pending.get(id) ?? new Set<string>();
    set.add(path);
    pending.set(id, set);
  }
  if (!timer) timer = setTimeout(() => void flush(), 120);
}
g.__rsOnChange = onChange;

async function start() {
  await ensureDirs();
  if (g.__rsWatcher) return;

  const watcher = watch(RESUMES_DIR, {
    ignoreInitial: true,
    // Editors save by writing a temp file and renaming it over the original: wait for the final file.
    atomic: true,
    awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
    ignored: (p: string) => {
      const name = p.split(sep).pop() ?? "";
      return (name.startsWith(".") && p !== RESUMES_DIR) || isJunk(name);
    },
    depth: 8,
  });
  watcher.on("all", (event: string, abs: string) => g.__rsOnChange?.(event, abs));
  watcher.on("error", (e) => console.error("[resume-studio] watcher:", e));
  g.__rsWatcher = watcher;
  g.__rsWatcherDelegates = true;
}

const autoAttached = ((globalThis as unknown as { __rsAuto?: WeakSet<object> }).__rsAuto ??= new WeakSet<object>());

/** The resume's compiler, with auto-snapshots after good builds (at most every few minutes). */
export async function compilerFor(id: string) {
  const c = await getCompiler(id);
  if (!autoAttached.has(c)) {
    autoAttached.add(c);
    c.onBuild((r) => {
      if (r.status === "ok") void maybeAutoSnapshot(id);
    });
  }
  return c;
}

let statusCache: { at: number; value: SystemStatus } | null = null;

export async function systemStatus(): Promise<SystemStatus> {
  const service = toolchainMode() === "service";
  if (!service && statusCache && Date.now() - statusCache.at < 10_000) return statusCache.value;
  const git = { available: !!findTool("git") };
  let value: SystemStatus;
  if (service) {
    // TeX runs in the compile service: report its toolchain (paths are inside the container).
    const info = await serviceInfo();
    const url = texService().url;
    if (info instanceof Error) {
      const engines = Object.fromEntries(TEX_ENGINES.map((e) => [e, null])) as Record<Engine, string | null>;
      value = {
        compiler: { mode: "service", url, error: info.message },
        tex: { available: false, latexmk: null, engines, synctex: null, version: null },
        ats: { available: false, missing: ["pdftotext", "pdffonts", "pdfinfo"] },
        git,
        root: ROOT,
      };
    } else {
      const engines = Object.fromEntries(TEX_ENGINES.map((e) => [e, info.tex.engines[e] ? e : null])) as Record<Engine, string | null>;
      value = {
        compiler: { mode: "service", url, error: null },
        tex: {
          available: info.tex.latexmk && info.tex.engines.pdflatex,
          latexmk: info.tex.latexmk ? "latexmk" : null,
          engines,
          synctex: info.tex.synctex ? "synctex" : null,
          version: info.tex.version,
        },
        ats: { available: info.poppler.missing.length === 0, missing: info.poppler.missing },
        git,
        root: ROOT,
      };
    }
    // Not cached here: serviceInfo is, briefly, so a service stopping or starting shows within seconds.
    return value;
  }
  const engines = Object.fromEntries(TEX_ENGINES.map((e) => [e, findTool(e)])) as Record<Engine, string | null>;
  const latexmk = findTool("latexmk");
  let version: string | null = null;
  if (engines.pdflatex) {
    const v = await run(engines.pdflatex, ["--version"], { timeoutMs: 5000 });
    version = /TeX Live \d{4}/.exec(v.stdout)?.[0] ?? v.stdout.split("\n")[0] ?? null;
  }
  const missing = await atsToolsMissing();
  value = {
    compiler: { mode: "local", url: null, error: null },
    tex: { available: !!latexmk && !!engines.pdflatex, latexmk, engines, synctex: findTool("synctex"), version },
    ats: { available: missing.length === 0, missing },
    git,
    root: ROOT,
  };
  statusCache = { at: Date.now(), value };
  return value;
}
