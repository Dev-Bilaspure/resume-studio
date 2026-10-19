import "server-only";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SyncChange, SyncConflict, SyncDiff, SyncItem, SyncStatus } from "@/lib/types";
import { ROOT, STATE_DIR } from "./config";
import { emit } from "./events";
import { HttpError, atomicWrite } from "./fsutil";
import { run } from "./run";
import { SYNCED_PLACES, findSecret, isSynced } from "./sync-rules";

// Backup and sync of your data to a private git repository you own (e.g. on GitHub), by hand: Upload sends
// what changed here, Download brings what changed there. The app owns a git repository for this
// (.resume-studio/sync/git) whose work tree is the app's root folder, but it only ever records the paths
// below, chosen by isSynced() rather than by ignore files (the project's own .gitignore ignores them).
//
//   resumes/**                               your resumes, tailored copies, jd.md, _profile/facts.json
//   .resume-studio/tailor/sessions/*.json    tailoring sessions: questions, answers, edits, choices
//   .resume-studio/ai.json                   AI provider choices (models, regions; never keys)
//
// Never synced: API keys (Keychain / secrets.json), build files and PDFs (rebuilt), snapshot history,
// trash. Nothing here is deleted or overwritten without a copy: a download keeps the replaced versions in
// .resume-studio/sync/backups/, and a download interrupted half-way finishes on the next sync.

const SYNC_DIR = join(STATE_DIR, "sync");
const GIT_DIR = join(SYNC_DIR, "git");
const CONFIG_FILE = join(SYNC_DIR, "config.json");
const PENDING_DIR = join(SYNC_DIR, "pending");
const BACKUP_DIR = join(SYNC_DIR, "backups");
const BRANCH = "main";
const REMOTE_REF = `refs/remotes/origin/${BRANCH}`;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const PATHSPEC = SYNCED_PLACES;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const KEEP_BACKUPS = 20;

// ---- Configuration ------------------------------------------------------------------------------------------

interface SyncConfig {
  url: string;
  connectedAt: string;
  lastUpload?: { at: string; commit: string };
  lastDownload?: { at: string; commit: string };
  lastCheck?: { at: string; error?: string };
}

async function readConfig(): Promise<SyncConfig | null> {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, "utf8")) as SyncConfig;
  } catch {
    return null;
  }
}

async function writeConfig(c: SyncConfig) {
  await mkdir(SYNC_DIR, { recursive: true });
  await atomicWrite(CONFIG_FILE, JSON.stringify(c, null, 2) + "\n");
}

// ---- git -----------------------------------------------------------------------------------------------------

function git(args: string[], opts: { input?: string; network?: boolean } = {}) {
  return run(
    "git",
    [
      "--git-dir",
      GIT_DIR,
      "--work-tree",
      ROOT,
      "--literal-pathspecs",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.quotepath=false",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    {
      cwd: ROOT,
      timeoutMs: opts.network ? 120_000 : 60_000,
      input: opts.input,
      maxOutput: 50_000_000,
      // Never wait for a password prompt: your saved git login (Keychain, gh, SSH agent) or a clear error.
      env: { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes", GIT_CONFIG_NOSYSTEM: "1" },
    },
  );
}

async function gitOk(args: string[], opts: { input?: string; network?: boolean } = {}): Promise<string> {
  const r = await git(args, opts);
  if (r.error) throw new HttpError(503, "git isn't installed");
  if (r.timedOut) throw new HttpError(504, opts.network ? "The repository didn't answer in time. Check your connection and try again." : `git ${args[0]} took too long`);
  if (r.code !== 0) throw opts.network ? networkError(r.stderr) : new Error(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

/** git's network errors, in plain words. */
function networkError(stderr: string): HttpError {
  const s = stderr.toLowerCase();
  if (/authentication failed|could not read username|permission denied|403|terminal prompts disabled|access denied|publickey/.test(s)) {
    return new HttpError(401, "GitHub didn't accept your login for this repository. Check that `git push` to it works in a terminal (for example after `gh auth login`), then try again.");
  }
  if (/repository not found|not found|does not exist/.test(s)) return new HttpError(404, "That repository wasn't found, or your login can't see it.");
  if (/could not resolve host|unable to access|network|timed out|connection/.test(s)) return new HttpError(503, "Couldn't reach the repository. Check your connection and try again.");
  return new HttpError(502, `The repository refused the request: ${stderr.trim().split("\n").at(-1)}`);
}

async function revParse(ref: string): Promise<string | null> {
  const r = await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** The commit both sides agreed on at the last upload or download (null before the first). */
const headCommit = () => revParse("HEAD");
/** The repository's latest commit, as of the last check (null: it's empty). */
const remoteCommit = () => revParse(REMOTE_REF);

let initialized: Promise<void> | null = null;
function ensureRepo(url: string): Promise<void> {
  return (initialized ??= (async () => {
    await mkdir(SYNC_DIR, { recursive: true });
    if (!existsSync(join(GIT_DIR, "HEAD"))) await gitOk(["init", "-q", "-b", BRANCH]);
    await gitOk(["config", "core.bare", "false"]);
    const current = await git(["remote", "get-url", "origin"]);
    if (current.code !== 0) await gitOk(["remote", "add", "origin", url]);
    else if (current.stdout.trim() !== url) await gitOk(["remote", "set-url", "origin", url]);
    await finishPending();
  })().catch((e) => {
    initialized = null;
    throw e;
  }));
}

// One sync operation at a time (status reads included, so nothing sees a half-applied download).
let lock: Promise<unknown> = Promise.resolve();
let busy = false;
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(async () => {
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  });
  lock = next.catch(() => {});
  return next;
}

// ---- What changed --------------------------------------------------------------------------------------------

/** Synced files that differ here from the last sync: path → added / modified / deleted. */
async function localChanges(): Promise<Map<string, SyncChange>> {
  const out = await gitOk(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=traditional", "--no-renames", "--", ...PATHSPEC]);
  const changes = new Map<string, SyncChange>();
  for (const entry of out.split("\0")) {
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!isSynced(path)) continue;
    changes.set(path, xy === "??" || xy === "!!" || xy.includes("A") ? "added" : xy.includes("D") ? "deleted" : "modified");
  }
  return changes;
}

/** Files that differ between two commits (or a commit and nothing). */
async function changesBetween(from: string | null, to: string): Promise<Map<string, SyncChange>> {
  const out = await gitOk(["diff", "--name-status", "-z", "--no-renames", from ?? EMPTY_TREE, to]);
  const parts = out.split("\0").filter(Boolean);
  const changes = new Map<string, SyncChange>();
  for (let i = 0; i + 1 < parts.length; i += 2) changes.set(parts[i + 1], parts[i] === "A" ? "added" : parts[i] === "D" ? "deleted" : "modified");
  return changes;
}

/** A file's content id here (null: not here), as git would store it. */
async function localBlob(path: string): Promise<string | null> {
  if (!existsSync(join(ROOT, path))) return null;
  return (await gitOk(["hash-object", "--no-filters", "--", path])).trim();
}

async function blobAt(commit: string | null, path: string): Promise<string | null> {
  if (!commit) return null;
  const r = await git(["rev-parse", "--verify", "-q", `${commit}:${path}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

interface Plan {
  head: string | null;
  remote: string | null;
  local: Map<string, SyncChange>;
  incoming: Map<string, SyncChange>;
  /** Changed in both places, to different contents. */
  conflicts: Map<string, { local: SyncChange; remote: SyncChange }>;
  /** Files in the repository that aren't Resume Studio data: nothing is downloaded while there are any. */
  foreign: string[];
}

async function plan(adopted = false): Promise<Plan> {
  const head = await headCommit();
  const remote = await remoteCommit();
  const local = await localChanges();
  const incoming = remote && remote !== head ? await changesBetween(head, remote) : new Map<string, SyncChange>();
  const foreign = [...incoming.keys()].filter((x) => !isSynced(x));
  for (const x of foreign) incoming.delete(x);
  const conflicts = new Map<string, { local: SyncChange; remote: SyncChange }>();
  for (const [path, change] of incoming) {
    const mine = local.get(path);
    if (!mine) continue;
    // The same change made in both places isn't a conflict.
    if ((await localBlob(path)) === (await blobAt(remote, path))) {
      local.delete(path);
      incoming.delete(path);
      continue;
    }
    conflicts.set(path, { local: mine, remote: change });
  }
  for (const p of conflicts.keys()) {
    local.delete(p);
    incoming.delete(p);
  }
  // The repository moved on, but everything it has, this computer has too (reconnecting, or the same
  // change made on both): take its commit as the shared starting point. Files here aren't touched.
  if (!adopted && remote && remote !== head && !incoming.size && !conflicts.size && !foreign.length) {
    await gitOk(["reset", "-q", remote]);
    return plan(true);
  }
  return { head, remote, local, incoming, conflicts, foreign };
}

// ---- Names people recognize ----------------------------------------------------------------------------------

type Describe = (path: string) => Promise<{ group: SyncItem["group"]; groupLabel: string; label: string }>;

/** Labels from whichever version of a file exists: here, at the last sync, or in the repository. */
function describer(commits: (string | null)[]): Describe {
  const cache = new Map<string, Promise<string | null>>();
  const read = (path: string) => {
    if (!cache.has(path))
      cache.set(
        path,
        (async () => {
          const here = await readFile(join(ROOT, path), "utf8").catch(() => null);
          if (here !== null) return here;
          for (const c of commits) {
            if (!c) continue;
            const r = await git(["show", `${c}:${path}`]);
            if (r.code === 0) return r.stdout;
          }
          return null;
        })(),
      );
    return cache.get(path)!;
  };
  const json = async (path: string) => {
    try {
      return JSON.parse((await read(path)) ?? "") as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  return async (path) => {
    if (path === ".resume-studio/ai.json") return { group: "settings", groupLabel: "AI provider settings", label: "ai.json" };
    if (path === ".resume-studio/preferences.json") return { group: "settings", groupLabel: "Preferences (editor, preview, layout)", label: "preferences.json" };
    const trashed = /^\.resume-studio\/trash\/([^/]+)\/(.+)$/.exec(path);
    if (trashed) {
      const meta = (await json(`.resume-studio/trash/${trashed[1]}/resume.json`)) as { name?: string } | null;
      return { group: "trash", groupLabel: `Trash: ${meta?.name?.trim() || trashed[1]}`, label: trashed[2] };
    }
    const session = /^\.resume-studio\/tailor\/sessions\/(.+)\.json$/.exec(path);
    if (session) {
      const s = (await json(path)) as { job?: { company?: string; role?: string } } | null;
      const role = s?.job?.role?.trim();
      const company = s?.job?.company?.trim();
      return { group: "session", groupLabel: `Tailoring: ${[role || "Untitled role", company].filter(Boolean).join(" · ")}`, label: `${session[1]}.json` };
    }
    const [, id, ...rest] = path.split("/");
    if (id === "_profile") return { group: "facts", groupLabel: "Your facts", label: rest.join("/") };
    const meta = (await json(`resumes/${id}/resume.json`)) as { name?: string } | null;
    return { group: "resume", groupLabel: meta?.name?.trim() || id, label: rest.join("/") };
  };
}

async function items(changes: Map<string, SyncChange>, describe: Describe): Promise<SyncItem[]> {
  const out: SyncItem[] = [];
  for (const [path, change] of changes) out.push({ path, change, ...(await describe(path)) });
  return out.sort((a, b) => a.group.localeCompare(b.group) || a.groupLabel.localeCompare(b.groupLabel) || a.label.localeCompare(b.label));
}

// ---- Status --------------------------------------------------------------------------------------------------

/** Where things stand. `check`: ask the repository what's new first (network). */
export async function syncStatus(check = false): Promise<SyncStatus> {
  const config = await readConfig();
  const blocked = await blockedReason();
  if (!config) return { connected: false, busy, blocked, local: [], remote: [], conflicts: [] };
  return exclusive(async () => {
    await ensureRepo(config.url);
    if (check) {
      try {
        await fetchRemote();
        config.lastCheck = { at: new Date().toISOString() };
      } catch (e) {
        config.lastCheck = { at: new Date().toISOString(), error: (e as Error).message };
      }
      await writeConfig(config);
    }
    const p = await plan();
    const describe = describer([p.head, p.remote]);
    const conflicts: SyncConflict[] = [];
    for (const [path, c] of p.conflicts) conflicts.push({ path, localChange: c.local, remoteChange: c.remote, ...(await describe(path)) });
    return {
      connected: true,
      url: config.url,
      webUrl: webUrl(config.url),
      busy,
      blocked,
      lastUpload: config.lastUpload,
      lastDownload: config.lastDownload,
      lastCheck: config.lastCheck,
      everSynced: !!p.head,
      remoteEmpty: config.lastCheck && !config.lastCheck.error ? !p.remote : undefined,
      remoteProblem: p.foreign.length
        ? `The repository contains files that aren't Resume Studio data (${p.foreign.slice(0, 3).join(", ")}${p.foreign.length > 3 ? "…" : ""}). Nothing will be downloaded until they're removed from it.`
        : undefined,
      local: await items(p.local, describe),
      remote: await items(p.incoming, describe),
      conflicts,
    };
  });
}

async function fetchRemote() {
  await gitOk(["fetch", "-q", "--prune", "--no-tags", "origin", `+refs/heads/${BRANCH}:${REMOTE_REF}`], { network: true }).catch(async (e) => {
    // An empty repository has no branch to fetch yet: that's fine, there's simply nothing there.
    const heads = await gitOk(["ls-remote", "--heads", "origin"], { network: true });
    if (heads.trim()) throw e;
    await git(["update-ref", "-d", REMOTE_REF]);
  });
}

// ---- Connecting ----------------------------------------------------------------------------------------------

const GITHUB = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

function webUrl(url: string): string | undefined {
  const m = GITHUB.exec(url);
  return m ? `https://github.com/${m[1]}/${m[2]}` : undefined;
}

/**
 * Refuses a repository anyone can read: your resumes, answers and contact details go there. On GitHub a
 * private repository is invisible to an anonymous request (404); a public one answers (200).
 */
async function checkPrivate(url: string) {
  const m = GITHUB.exec(url);
  if (!m) return;
  let status: number;
  try {
    status = (await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}`, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) })).status;
  } catch {
    throw new HttpError(503, "Couldn't reach GitHub to check that the repository is private. Check your connection and try again.");
  }
  if (status === 200) throw new HttpError(400, "This repository is public: anyone could read your resumes and answers. Make it private on GitHub (Settings → General → Danger Zone), then connect again.");
  if (status !== 404) throw new HttpError(503, `GitHub answered ${status} when checking that the repository is private. Try again in a minute.`);
}

export async function connectSync(rawUrl: string): Promise<SyncStatus> {
  const url = rawUrl.trim().replace(/\/+$/, "");
  // A hosted repository (https, ssh), or one in a folder (file://, e.g. on an external drive).
  if (!/^(https:\/\/|ssh:\/\/|git@|file:\/\/\/)[^\s]+$/.test(url)) throw new HttpError(400, "Paste the repository's address, like https://github.com/you/resume-studio-data");
  const config = await readConfig();
  if (config && config.url !== url) throw new HttpError(409, `Already connected to ${config.url}. Disconnect first.`);
  await checkPrivate(url);
  // Your git login must be able to read it (and later write to it).
  const probe = await run("git", ["ls-remote", "--heads", url], { timeoutMs: 60_000, env: { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } });
  if (probe.error) throw new HttpError(503, "git isn't installed");
  if (probe.code !== 0) throw networkError(probe.stderr);
  await exclusive(async () => {
    initialized = null;
    await ensureRepo(url);
  });
  await writeConfig({ url, connectedAt: new Date().toISOString() });
  return syncStatus(true);
}

/** Forgets the connection here. Your files and the repository stay as they are. */
export async function disconnectSync(): Promise<void> {
  await exclusive(async () => {
    await rm(CONFIG_FILE, { force: true });
    await rm(GIT_DIR, { recursive: true, force: true });
    initialized = null;
  });
}

// ---- Guards ----------------------------------------------------------------------------------------------------

/** Tailoring runs in progress (see tailor.ts): their sessions change every few seconds. */
const runningRuns = () => (globalThis as unknown as { __rsTailorRuns?: Map<string, unknown> }).__rsTailorRuns?.size ?? 0;

async function blockedReason(): Promise<string | undefined> {
  return runningRuns() ? "A tailoring run is in progress. Sync when it's done, so its session is saved complete." : undefined;
}

/** Refuses to upload a secret or a file too large for the repository. */
async function checkUploadable(paths: string[]) {
  const problems: string[] = [];
  for (const path of paths) {
    const abs = join(ROOT, path);
    const st = await stat(abs).catch(() => null);
    if (!st) continue;
    if (st.size > MAX_FILE_BYTES) {
      problems.push(`${path} is ${Math.round(st.size / 1024 / 1024)} MB (the limit is 50 MB)`);
      continue;
    }
    if (st.size > 5 * 1024 * 1024) continue;
    const secret = findSecret(await readFile(abs, "utf8").catch(() => ""));
    if (secret) problems.push(`${path} contains what looks like ${secret}`);
  }
  if (problems.length) throw new HttpError(400, `Not uploaded, to keep secrets and oversized files out of the repository: ${problems.join("; ")}. Remove it from the file, then upload again.`);
}

// ---- Upload ----------------------------------------------------------------------------------------------------

export async function uploadSync(): Promise<SyncStatus> {
  const config = await requireConfig();
  const blocked = await blockedReason();
  if (blocked) throw new HttpError(409, blocked);
  await checkPrivate(config.url);
  await exclusive(async () => {
    await ensureRepo(config.url);
    await fetchRemote();
    const p = await plan();
    if (p.remote && p.remote !== p.head) {
      throw new HttpError(409, "The repository has changes this computer doesn't have yet. Download them first, then upload.");
    }
    if (!p.local.size) throw new HttpError(409, "Nothing to upload: everything here is already in the repository.");
    const paths = [...p.local.keys()];
    await checkUploadable(paths.filter((x) => p.local.get(x) !== "deleted"));

    // Stage exactly these paths (forced: the project's .gitignore ignores the data folders), commit, push.
    await gitOk(["add", "-A", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: paths.join("\0") + "\0" });
    const identity = await commitIdentity();
    await gitOk([...identity, "commit", "-q", "--no-verify", "-m", uploadMessage(p.local)]);
    const commit = (await headCommit())!;
    try {
      await gitOk(["push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`], { network: true });
    } catch (e) {
      // Not uploaded: undo the commit, keeping every change here as it was, so nothing is lost or half-done.
      await gitOk(p.head ? ["reset", "-q", "--soft", p.head] : ["update-ref", "-d", `refs/heads/${BRANCH}`]);
      await gitOk(["reset", "-q"]);
      throw e;
    }
    await gitOk(["update-ref", REMOTE_REF, commit]);
    config.lastUpload = { at: new Date().toISOString(), commit };
    config.lastCheck = { at: config.lastUpload.at };
    await writeConfig(config);
  });
  return syncStatus();
}

/** Your own git name and email when you have them, else the app's. */
async function commitIdentity(): Promise<string[]> {
  const name = (await git(["config", "user.name"])).stdout.trim();
  const email = (await git(["config", "user.email"])).stdout.trim();
  return name && email ? [] : ["-c", "user.name=Resume Studio", "-c", "user.email=sync@resume-studio.local"];
}

function uploadMessage(changes: Map<string, SyncChange>): string {
  const n = changes.size;
  const kinds = new Set([...changes.keys()].map((p) => (p.startsWith(".resume-studio/tailor/") ? "tailoring sessions" : p.startsWith("resumes/_profile/") ? "facts" : p.startsWith("resumes/") ? "resumes" : "settings")));
  return `Upload from ${hostname().replace(/\.local$/, "")}: ${n} file${n === 1 ? "" : "s"} (${[...kinds].join(", ")})`;
}

// ---- Download --------------------------------------------------------------------------------------------------

/** For each conflict: keep this computer's version, or take the repository's. */
export type Resolutions = Record<string, "local" | "remote">;

export async function downloadSync(resolutions: Resolutions = {}): Promise<SyncStatus> {
  const config = await requireConfig();
  const blocked = await blockedReason();
  if (blocked) throw new HttpError(409, blocked);
  await exclusive(async () => {
    await ensureRepo(config.url);
    await fetchRemote();
    const p = await plan();
    if (!p.remote || p.remote === p.head) throw new HttpError(409, "Nothing to download: this computer already has everything in the repository.");
    const unresolved = [...p.conflicts.keys()].filter((x) => resolutions[x] !== "local" && resolutions[x] !== "remote");
    if (unresolved.length) throw new HttpError(409, `Choose which version to keep for ${unresolved.length} file${unresolved.length === 1 ? "" : "s"} changed in both places.`);

    // Only data paths may come from the repository: anything else would land in the app's own folder.
    const remoteFiles = (await gitOk(["ls-tree", "-r", "-z", "--name-only", p.remote])).split("\0").filter(Boolean);
    const foreign = remoteFiles.filter((f) => !isSynced(f));
    if (foreign.length) throw new HttpError(400, `The repository contains files that aren't Resume Studio data (${foreign.slice(0, 3).join(", ")}). Download refused, so nothing outside your data is touched.`);

    // Kept and put back after the repository's version is checked out: your changes not uploaded yet, and
    // the conflicts where you chose this computer's version. Replaced: conflicts where you chose the
    // repository's (a copy goes to backups).
    const keep = [...p.local.keys(), ...[...p.conflicts.keys()].filter((x) => resolutions[x] === "local")];
    const replaced = [...p.conflicts.keys()].filter((x) => resolutions[x] === "remote");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (replaced.length) await backup(replaced, join(BACKUP_DIR, stamp));
    await savePending(keep, p.remote);
    await gitOk(["reset", "-q", "--hard", p.remote]);
    await finishPending();
    await pruneBackups();
    config.lastDownload = { at: new Date().toISOString(), commit: p.remote };
    config.lastCheck = { at: config.lastDownload.at };
    await writeConfig(config);
  });
  // Resumes rebuild on their own (the file watcher sees the new files); the lists refresh.
  emit({ type: "resumes" });
  return syncStatus();
}

/** Copies files (as they are here) under `dir`, keeping their paths. */
async function backup(paths: string[], dir: string) {
  for (const path of paths) {
    const src = join(ROOT, path);
    if (!existsSync(src)) continue;
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await copyFile(src, join(dir, path));
  }
}

/**
 * Before a download replaces the files: the ones to keep are copied aside with a manifest. If the app stops
 * half-way, the next sync operation puts them back (finishPending), so a download is never half-applied.
 */
async function savePending(paths: string[], target: string) {
  await rm(PENDING_DIR, { recursive: true, force: true });
  const staging = `${PENDING_DIR}.${randomBytes(4).toString("hex")}`;
  const files: Record<string, "file" | "deleted"> = {};
  for (const path of paths) {
    const src = join(ROOT, path);
    if (existsSync(src)) {
      await mkdir(dirname(join(staging, "files", path)), { recursive: true });
      await copyFile(src, join(staging, "files", path));
      files[path] = "file";
    } else files[path] = "deleted";
  }
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, "manifest.json"), JSON.stringify({ target, files }));
  await rename(staging, PENDING_DIR);
}

async function finishPending() {
  const manifest = await readFile(join(PENDING_DIR, "manifest.json"), "utf8").catch(() => null);
  if (manifest === null) return;
  const { files } = JSON.parse(manifest) as { files: Record<string, "file" | "deleted"> };
  for (const [path, kind] of Object.entries(files)) {
    if (!isSynced(path)) continue;
    const dest = join(ROOT, path);
    if (kind === "deleted") await rm(dest, { force: true });
    else {
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(PENDING_DIR, "files", path), dest);
    }
  }
  await rm(PENDING_DIR, { recursive: true, force: true });
}

async function pruneBackups() {
  const sets = (await readdir(BACKUP_DIR).catch(() => [] as string[])).sort();
  for (const old of sets.slice(0, Math.max(0, sets.length - KEEP_BACKUPS))) await rm(join(BACKUP_DIR, old), { recursive: true, force: true });
}

async function requireConfig(): Promise<SyncConfig> {
  const c = await readConfig();
  if (!c) throw new HttpError(409, "Sync isn't set up: connect a repository first.");
  return c;
}

// ---- Diffs -----------------------------------------------------------------------------------------------------

/**
 * What changed in one file. side "local": since the last sync, here; "remote": since the last sync, in the
 * repository; "conflict": the repository's version against this computer's.
 */
export async function syncDiff(path: string, side: "local" | "remote" | "conflict"): Promise<SyncDiff> {
  if (!isSynced(path)) throw new HttpError(400, "Not a synced file");
  const config = await requireConfig();
  return exclusive(async () => {
    await ensureRepo(config.url);
    const head = await headCommit();
    const remote = await remoteCommit();
    const at = async (commit: string | null) => {
      if (!commit) return null;
      const r = await git(["show", `${commit}:${path}`]);
      return r.code === 0 ? r.stdout : null;
    };
    const here = () => readFile(join(ROOT, path), "utf8").catch(() => null);
    const [before, after] =
      side === "local" ? [await at(head), await here()] : side === "remote" ? [await at(head), await at(remote)] : [await at(remote), await here()];
    const labels = side === "conflict" ? ["the repository", "this computer"] : ["last sync", side === "local" ? "this computer" : "the repository"];
    return diffText(path, before, after, labels as [string, string]);
  });
}

async function diffText(path: string, before: string | null, after: string | null, labels: [string, string]): Promise<SyncDiff> {
  if ((before ?? "").includes("\0") || (after ?? "").includes("\0")) return { path, binary: true, text: "" };
  const dir = join(tmpdir(), `rs-diff-${randomBytes(6).toString("hex")}`);
  await mkdir(dir);
  try {
    const a = join(dir, "a");
    const b = join(dir, "b");
    await writeFile(a, before ?? "");
    await writeFile(b, after ?? "");
    const r = await run("git", ["diff", "--no-index", "--no-color", "-U3", "--src-prefix=", "--dst-prefix=", a, b], { timeoutMs: 30_000 });
    // Header lines name the temp files: replace them with what they are.
    const text = r.stdout
      .split("\n")
      .filter((l) => !/^(diff --git|index |new file mode|deleted file mode)/.test(l))
      .map((l) => (l.startsWith("--- ") ? `--- ${labels[0]}${before === null ? " (none)" : ""}` : l.startsWith("+++ ") ? `+++ ${labels[1]}${after === null ? " (none)" : ""}` : l))
      .join("\n");
    return { path, binary: false, text: text.length > 400_000 ? `${text.slice(0, 400_000)}\n… (cut: the rest is too long to show)` : text };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
