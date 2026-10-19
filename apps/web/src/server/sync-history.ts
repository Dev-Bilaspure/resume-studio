import "server-only";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { SyncHistory } from "@/lib/types";
import { RESUMES_DIR, SNAPSHOT_GIT_DIR } from "./config";
import { run } from "./run";
import { ensureSnapshotRepo } from "./snapshots";

// Snapshot history in Backup & sync. Snapshots are commits in their own repository (.resume-studio/git,
// branch "snapshots", labels as tags "snap/<resume>/<label>"); in your data repository they're the branch
// "snapshots" and the same tags, next to the data on "main".
//
// The sync repository is the hub. Its refs:
//   refs/local-history/heads/snapshots, refs/local-history/labels/*    this computer's (copied before each check)
//   refs/remotes/origin/snapshots,      refs/remote-history/labels/*   the repository's (fetched)
//   refs/base-history/snapshots,        refs/base-history/labels/*     what both had at the last sync
//
// Snapshots are only ever added, so histories never truly conflict: two computers' histories are joined
// with a merge commit that keeps every snapshot from both (listings use --full-history). Labels can move or
// go away, so they're merged against the base: a label changed only on one side takes that side's value;
// changed on both, this computer's wins.

export const LOCAL_BRANCH = "refs/local-history/heads/snapshots";
const LOCAL_LABELS = "refs/local-history/labels/";
export const REMOTE_BRANCH = "refs/remotes/origin/snapshots";
const REMOTE_LABELS = "refs/remote-history/labels/";
const BASE_BRANCH = "refs/base-history/snapshots";
const BASE_LABELS = "refs/base-history/labels/";

/** What a sync repository command returns. */
export type Git = (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** Fetch refspecs that bring the repository's history with its data. */
export const REMOTE_HISTORY_REFSPECS = [`+refs/tags/snap/*:${REMOTE_LABELS}*`];

/** A label's name: "<resume>/<label>", as in refs/tags/snap/<resume>/<label>. */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[a-z0-9][a-z0-9-]*$/;

function snapGit(args: string[]) {
  return run(
    "git",
    ["--git-dir", SNAPSHOT_GIT_DIR, "--work-tree", RESUMES_DIR, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args],
    { cwd: RESUMES_DIR, timeoutMs: 120_000, env: { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" } },
  );
}

async function ok(r: Promise<{ code: number | null; stdout: string; stderr: string; error?: unknown }>, what: string): Promise<string> {
  const res = await r;
  if (res.code !== 0) throw new Error(`${what} failed: ${res.stderr.trim() || res.stdout.trim()}`);
  return res.stdout;
}

async function rev(git: Git, ref: string): Promise<string | null> {
  const r = await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function labelsAt(git: Git, prefix: string): Promise<Map<string, string>> {
  const out = await ok(git(["for-each-ref", "--format=%(refname) %(objectname)", prefix]), "listing labels");
  const m = new Map<string, string>();
  for (const line of out.split("\n").filter(Boolean)) {
    const [ref, sha] = line.split(" ");
    const name = ref.slice(prefix.length);
    if (LABEL.test(name)) m.set(name, sha);
  }
  return m;
}

async function deleteRefs(git: Git, prefix: string) {
  const out = await ok(git(["for-each-ref", "--format=%(refname)", prefix]), "listing refs");
  const refs = out.split("\n").filter(Boolean);
  for (const ref of refs) await ok(git(["update-ref", "-d", ref]), `deleting ${ref}`);
}

async function setRef(git: Git, ref: string, sha: string | null) {
  if (sha) await ok(git(["update-ref", ref, sha]), `setting ${ref}`);
  else await git(["update-ref", "-d", ref]);
}

async function setLabels(git: Git, prefix: string, labels: Map<string, string>) {
  const current = await labelsAt(git, prefix);
  for (const name of current.keys()) if (!labels.has(name)) await ok(git(["update-ref", "-d", prefix + name]), `deleting label ${name}`);
  for (const [name, sha] of labels) if (current.get(name) !== sha) await ok(git(["update-ref", prefix + name, sha]), `setting label ${name}`);
}

/** Copies this computer's snapshot history into the sync repository (local, no network). */
export async function importLocalHistory(git: Git) {
  const head = await snapGit(["rev-parse", "--verify", "-q", "refs/heads/snapshots"]);
  if (!existsSync(join(SNAPSHOT_GIT_DIR, "HEAD")) || head.code !== 0) {
    await deleteRefs(git, "refs/local-history/");
    return;
  }
  await ok(
    git(["fetch", "-q", "--prune", "--no-tags", SNAPSHOT_GIT_DIR, "+refs/heads/snapshots:" + LOCAL_BRANCH, `+refs/tags/snap/*:${LOCAL_LABELS}*`]),
    "reading the snapshot history",
  );
}

async function count(git: Git, include: string | null, exclude: string | null): Promise<number> {
  if (!include) return 0;
  const out = await ok(git(["rev-list", "--count", "--no-merges", include, ...(exclude ? [`^${exclude}`] : [])]), "counting snapshots");
  return Number(out.trim()) || 0;
}

/** What differs between this computer's history and the repository's. */
export async function historyStatus(git: Git): Promise<SyncHistory> {
  const [local, remote] = [await rev(git, LOCAL_BRANCH), await rev(git, REMOTE_BRANCH)];
  const [l, r, b] = [await labelsAt(git, LOCAL_LABELS), await labelsAt(git, REMOTE_LABELS), await labelsAt(git, BASE_LABELS)];
  const names = new Set([...l.keys(), ...r.keys(), ...b.keys()]);
  const localLabels: string[] = [];
  const remoteLabels: string[] = [];
  for (const n of names) {
    if (l.get(n) === r.get(n)) continue;
    if (l.get(n) !== b.get(n)) localLabels.push(n);
    if (r.get(n) !== b.get(n)) remoteLabels.push(n);
  }
  return {
    localSnapshots: await count(git, local, remote),
    remoteSnapshots: await count(git, remote, local),
    localLabels: localLabels.sort(),
    remoteLabels: remoteLabels.sort(),
    labelConflicts: localLabels.filter((n) => remoteLabels.includes(n)).sort(),
  };
}

export const historyIncoming = (h: SyncHistory) => h.remoteSnapshots > 0 || h.remoteLabels.length > 0;
export const historyOutgoing = (h: SyncHistory) => h.localSnapshots > 0 || h.localLabels.length > 0;

/**
 * Push refspecs for this computer's history. Only used when the repository has nothing this computer
 * doesn't (uploads wait for a download first), so the branch moves forward and the label set it sends,
 * pruned, is the merged truth.
 */
export async function historyPushRefspecs(git: Git): Promise<string[]> {
  const local = await rev(git, LOCAL_BRANCH);
  return [...(local ? [`${LOCAL_BRANCH}:refs/heads/snapshots`] : []), `+${LOCAL_LABELS}*:refs/tags/snap/*`];
}

/** After an upload: the repository now has exactly this computer's history. */
export async function recordUploadedHistory(git: Git) {
  const local = await rev(git, LOCAL_BRANCH);
  const labels = await labelsAt(git, LOCAL_LABELS);
  for (const prefix of [BASE_LABELS, REMOTE_LABELS]) await setLabels(git, prefix, labels);
  await setRef(git, BASE_BRANCH, local);
  await setRef(git, REMOTE_BRANCH, local);
}

/**
 * Brings the repository's history into this computer's snapshot repository: fast-forward, or join two
 * histories keeping every snapshot; then merge the labels. Never touches your resumes (only refs and
 * objects). Returns what was added, for the summary.
 */
export async function downloadHistory(git: Git, syncGitDir: string): Promise<{ snapshots: number; labels: number; keptHere: string[] }> {
  const remote = await rev(git, REMOTE_BRANCH);
  const status = await historyStatus(git);
  if (!historyIncoming(status)) return { snapshots: 0, labels: 0, keptHere: [] };
  await ensureSnapshotRepo();

  // Bring the repository's commits (and what its labels point at) over, under temporary names.
  await ok(snapGit(["fetch", "-q", "--no-tags", syncGitDir, ...(remote ? [`+${REMOTE_BRANCH}:refs/sync/incoming`] : []), `+${REMOTE_LABELS}*:refs/sync/labels/*`]), "copying the snapshot history");
  try {
    if (remote) await joinBranch(remote);
    // Labels: three-way, against what both had at the last sync.
    const here = await labelsAt(snapGit, "refs/tags/snap/");
    const there = await labelsAt(git, REMOTE_LABELS);
    const base = await labelsAt(git, BASE_LABELS);
    const merged = new Map(here);
    const keptHere: string[] = [];
    let changed = 0;
    for (const n of new Set([...here.keys(), ...there.keys(), ...base.keys()])) {
      const [h, t, b] = [here.get(n), there.get(n), base.get(n)];
      if (h === t || t === b) continue; // same, or only this computer changed it
      if (h === b) {
        // Only the repository changed it: take that (moved, added, or removed).
        if (t) merged.set(n, t);
        else merged.delete(n);
        changed++;
      } else keptHere.push(n); // changed on both sides: this computer's wins (and is uploaded next)
    }
    await setLabels(snapGit, "refs/tags/snap/", merged);
    // What both now have: the repository's history and labels.
    await setRef(git, BASE_BRANCH, remote);
    await setLabels(git, BASE_LABELS, there);
    await importLocalHistory(git);
    return { snapshots: status.remoteSnapshots, labels: changed, keptHere };
  } finally {
    for (const ref of (await ok(snapGit(["for-each-ref", "--format=%(refname)", "refs/sync/"]), "listing")).split("\n").filter(Boolean)) await snapGit(["update-ref", "-d", ref]);
  }
}

/**
 * Moves this computer's snapshots branch to include the repository's. The branch is only updated if it
 * hasn't moved meanwhile (a snapshot taken during the download): then it starts over, so no snapshot is lost.
 */
async function joinBranch(remote: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const here = await rev(snapGit, "refs/heads/snapshots");
    let next: string;
    if (!here) next = remote;
    else if ((await snapGit(["merge-base", "--is-ancestor", here, remote])).code === 0) next = remote;
    else if ((await snapGit(["merge-base", "--is-ancestor", remote, here])).code === 0) return;
    else {
      // Diverged: a merge commit with this computer's tree (the resumes as they are here), whose parents
      // are both histories. It isn't a snapshot itself (listings skip merges).
      const tree = (await ok(snapGit(["rev-parse", `${here}^{tree}`]), "reading the history")).trim();
      next = (
        await ok(snapGit(["commit-tree", tree, "-p", here, "-p", remote, "-m", `Joined the snapshot history of ${hostname().replace(/\.local$/, "")} and the repository`]), "joining histories")
      ).trim();
    }
    const moved = await snapGit(["update-ref", "refs/heads/snapshots", next, ...(here ? [here] : ["0000000000000000000000000000000000000000"])]);
    if (moved.code === 0) return;
  }
  throw new Error("The snapshot history kept changing during the download. Try again.");
}
