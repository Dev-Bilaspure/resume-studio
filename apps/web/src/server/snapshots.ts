import "server-only";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuildResult, SnapshotInfo } from "@/lib/types";
import { PREVIEW_DIR, RESUMES_DIR, SNAPSHOT_GIT_DIR } from "./config";
import { compileWithFallback } from "./compiler";
import { emit } from "./events";
import { HttpError, safeJoin } from "./fsutil";
import { run } from "./run";
import { engineFor, getResume, resumeDir } from "./workspace";

// Snapshots are git commits in a repository the app owns (.resume-studio/git) whose work tree is
// resumes/. It never touches the repo the app lives in, and you never have to use git yourself.
// Each commit records one resume folder; labels are tags "snap/<resume>/<label>".

const SEP = "\x1f";
const REC = "\x1e";
const AUTO_TRAILER = "Snapshot-Auto: yes";
const AUTO_INTERVAL_MS = 10 * 60_000;

function git(args: string[], opts: { input?: string } = {}) {
  return run(
    "git",
    [
      "--git-dir",
      SNAPSHOT_GIT_DIR,
      "--work-tree",
      RESUMES_DIR,
      "-c",
      "core.hooksPath=/dev/null", // no hooks from your global config
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.quotepath=false",
      ...args,
    ],
    { cwd: RESUMES_DIR, timeoutMs: 30_000, input: opts.input, env: { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" } },
  );
}

async function gitOk(args: string[]) {
  const r = await git(args);
  if (r.error) throw new HttpError(503, "git isn't available");
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

let ready: Promise<void> | null = null;
function ensureRepo(): Promise<void> {
  return (ready ??= (async () => {
    await mkdir(RESUMES_DIR, { recursive: true });
    if (!existsSync(join(SNAPSHOT_GIT_DIR, "HEAD"))) {
      await gitOk(["init", "-q", "-b", "snapshots"]);
      await gitOk(["config", "user.name", "Resume Studio"]);
      await gitOk(["config", "user.email", "snapshots@resume-studio.local"]);
    }
    // Never record editor temp files and OS clutter.
    await mkdir(join(SNAPSHOT_GIT_DIR, "info"), { recursive: true });
    await writeFile(join(SNAPSHOT_GIT_DIR, "info", "exclude"), ["*.tmp", "*~", "*.swp", "*.swx", ".DS_Store", "#*#", ".#*", ""].join("\n"));
  })().catch((e) => {
    ready = null;
    throw e;
  }));
}

function labelRef(id: string, label: string) {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!slug) throw new HttpError(400, "Label must contain letters or numbers");
  return `snap/${id}/${slug}`;
}

export async function listSnapshots(id: string): Promise<SnapshotInfo[]> {
  resumeDir(id);
  await ensureRepo();
  const head = await git(["rev-parse", "--verify", "-q", "HEAD"]);
  if (head.code !== 0) return [];
  const log = await gitOk(["log", `--format=${REC}%H${SEP}%ct${SEP}%s${SEP}%b${SEP}`, "--shortstat", "--", `${id}/`]);
  const tags = await gitOk(["for-each-ref", `refs/tags/snap/${id}/`, "--format=%(objectname) %(refname:lstrip=4)"]);
  const labels = new Map<string, string[]>();
  for (const line of tags.split("\n").filter(Boolean)) {
    const [sha, ...rest] = line.split(" ");
    labels.set(sha, [...(labels.get(sha) ?? []), rest.join(" ")]);
  }
  return log
    .split(REC)
    .filter((r) => r.trim())
    .map((rec) => {
      const [sha, ct, subject, body, stat = ""] = rec.split(SEP);
      return {
        sha,
        shortSha: sha.slice(0, 7),
        message: subject,
        labels: labels.get(sha) ?? [],
        createdAt: Number(ct) * 1000,
        auto: body.includes(AUTO_TRAILER),
        insertions: Number(/(\d+) insertion/.exec(stat)?.[1] ?? 0),
        deletions: Number(/(\d+) deletion/.exec(stat)?.[1] ?? 0),
      };
    });
}

/**
 * Records the resume's current files. If nothing changed since the last snapshot, no new commit is
 * made; a label is then attached to that latest snapshot instead.
 */
export async function createSnapshot(id: string, opts: { message?: string; label?: string; auto?: boolean }): Promise<SnapshotInfo | null> {
  resumeDir(id);
  await ensureRepo();
  await gitOk(["add", "-A", "--", `${id}/`]);
  const staged = await git(["diff", "--cached", "--quiet", "--", `${id}/`]);
  const hasHead = (await git(["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
  const changed = staged.code !== 0 || !hasHead;
  if (changed) {
    const message = (opts.message?.trim() || (opts.auto ? "Auto-snapshot" : "Snapshot")).replace(/\s+/g, " ").slice(0, 200);
    const args = ["commit", "-q", "--allow-empty", "-m", message];
    if (opts.auto) args.push("-m", AUTO_TRAILER);
    await gitOk([...args, "--", `${id}/`]);
  }
  const list = await listSnapshots(id);
  const latest = list[0] ?? null;
  if (latest && opts.label) {
    await gitOk(["tag", "-f", labelRef(id, opts.label), latest.sha]);
  }
  if (changed || opts.label) emit({ type: "snapshots", resumeId: id });
  return (await listSnapshots(id))[0] ?? null;
}

/** Puts a label on any snapshot of the resume (moving it if another snapshot had it). */
export async function labelSnapshot(id: string, sha: string, label: string) {
  await ensureRepo();
  await inResumeHistory(id, sha);
  await gitOk(["tag", "-f", labelRef(id, label), sha]);
  emit({ type: "snapshots", resumeId: id });
}

export async function removeLabel(id: string, label: string) {
  await ensureRepo();
  await gitOk(["tag", "-d", `snap/${id}/${label}`]);
  emit({ type: "snapshots", resumeId: id });
}

function checkSha(sha: string) {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new HttpError(400, "Invalid snapshot id");
}

async function inResumeHistory(id: string, sha: string) {
  checkSha(sha);
  const r = await git(["ls-tree", "--name-only", sha, "--", `${id}/`]);
  if (r.code !== 0 || !r.stdout.trim()) throw new HttpError(404, "That snapshot doesn't contain this resume");
}

/** Files (relative to the resume folder) recorded in a snapshot. */
export async function snapshotFiles(id: string, sha: string): Promise<string[]> {
  await ensureRepo();
  await inResumeHistory(id, sha);
  const out = await gitOk(["ls-tree", "-r", "--name-only", sha, "--", `${id}/`]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((p) => p.slice(id.length + 1))
    .filter((p) => p !== "resume.json");
}

export async function snapshotFile(id: string, sha: string, path: string): Promise<string> {
  await ensureRepo();
  await inResumeHistory(id, sha);
  safeJoin(resumeDir(id), path); // validates the path
  const r = await git(["show", `${sha}:${id}/${path}`]);
  if (r.code !== 0) throw new HttpError(404, `"${path}" isn't in that snapshot`);
  return r.stdout;
}

/** Puts the resume back to a snapshot. The current state is snapshotted first, so a restore is undoable. */
export async function restoreSnapshot(id: string, sha: string): Promise<void> {
  await ensureRepo();
  await inResumeHistory(id, sha);
  await createSnapshot(id, { message: `Before restoring ${sha.slice(0, 7)}`, auto: true });
  await gitOk(["restore", `--source=${sha}`, "--staged", "--worktree", "--", `${id}/`]);
  await createSnapshot(id, { message: `Restored ${sha.slice(0, 7)}`, auto: true });
}

/** Snapshots now if the resume changed and the last snapshot is older than the auto interval. */
export async function maybeAutoSnapshot(id: string) {
  try {
    const list = await listSnapshots(id);
    if (list[0] && Date.now() - list[0].createdAt < AUTO_INTERVAL_MS) return;
    await createSnapshot(id, { auto: true });
  } catch {
    // Snapshots are best-effort; never fail a build over them.
  }
}

// ---- Rendering a snapshot without restoring it ------------------------------------------------------------

const previews = new Map<string, Promise<BuildResult>>();

/** Compiles a snapshot in a scratch folder (cached per snapshot) and returns the result. */
export function previewSnapshot(id: string, sha: string): Promise<BuildResult> {
  const key = `${id}@${sha}`;
  let p = previews.get(key);
  if (!p) {
    p = buildPreview(id, sha).catch((e) => {
      previews.delete(key);
      throw e;
    });
    previews.set(key, p);
  }
  return p;
}

export function snapshotPdfPath(id: string, sha: string) {
  checkSha(sha);
  resumeDir(id);
  return join(PREVIEW_DIR, `${id}@${sha}`, "out", "preview.pdf");
}

async function buildPreview(id: string, sha: string): Promise<BuildResult> {
  await ensureRepo();
  await inResumeHistory(id, sha);
  const root = join(PREVIEW_DIR, `${id}@${sha}`);
  const cached = join(root, "result.json");
  if (existsSync(cached)) return JSON.parse(await readFile(cached, "utf8"));

  await rm(root, { recursive: true, force: true });
  const src = join(root, "src");
  await mkdir(src, { recursive: true });
  const tar = join(root, "snapshot.tar");
  await gitOk(["archive", "--format=tar", "-o", tar, sha, `${id}/`]);
  const untar = await run("tar", ["-xf", tar, "-C", src, "--strip-components=1"], { timeoutMs: 30_000 });
  if (untar.code !== 0) throw new Error(`Couldn't unpack the snapshot: ${untar.stderr}`);

  let meta: { mainFile?: string; engine?: string; trusted?: boolean } = {};
  try {
    meta = JSON.parse(await readFile(join(src, "resume.json"), "utf8"));
  } catch {
    meta = { mainFile: (await getResume(id)).mainFile };
  }
  const mainFile = meta.mainFile ?? "main.tex";
  const engine = await engineFor(src, mainFile, meta.engine === "xelatex" || meta.engine === "lualatex" || meta.engine === "latex" ? meta.engine : "pdflatex");
  const started = Date.now();
  // A snapshot preview never gets shell escape or the project latexmkrc: it's old content, rendered on demand.
  const raw = await compileWithFallback({ srcDir: src, outDir: join(root, "build"), mainFile, engine });
  await mkdir(join(root, "out"), { recursive: true });
  if (raw.pdfPath) await writeFile(snapshotPdfPath(id, sha), await readFile(raw.pdfPath));
  const result: BuildResult = {
    id: 0,
    resumeId: id,
    status: raw.ok ? "ok" : raw.timedOut ? "timeout" : raw.startFailed ? "failed-to-start" : "error",
    pdfUrl: raw.pdfPath ? `/api/resumes/${encodeURIComponent(id)}/snapshots/${sha}/pdf` : null,
    partialPdfUrl: null,
    startedAt: started,
    durationMs: Date.now() - started,
    pages: null,
    diagnostics: raw.startFailed ? [{ severity: "error", kind: "other", file: null, line: null, message: raw.startFailed }] : raw.diagnostics,
    outputTail: raw.outputTail,
    ats: null,
  };
  await rm(join(root, "build"), { recursive: true, force: true });
  await rm(tar, { force: true });
  if (raw.startFailed === null) await writeFile(cached, JSON.stringify(result));
  return result;
}
