import "server-only";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/**
 * Where everything lives. Default: next to the app, in the repo it runs from.
 *   <root>/resumes/          your resumes (plain folders of .tex files, edit them with anything)
 *   <root>/.resume-studio/   app state: builds, published PDFs, snapshot history
 * Override with RESUME_STUDIO_ROOT=/some/dir.
 */
// (turbopackIgnore: these are data directories, not files the server bundle needs to trace.)
export const ROOT = resolve(/*turbopackIgnore: true*/ process.env.RESUME_STUDIO_ROOT ?? process.cwd());
export const RESUMES_DIR = join(ROOT, "resumes");
export const STATE_DIR = join(ROOT, ".resume-studio");
export const BUILD_DIR = join(STATE_DIR, "build");
export const PUBLISH_DIR = join(STATE_DIR, "publish");
export const TRASH_DIR = join(STATE_DIR, "trash");
export const SNAPSHOT_GIT_DIR = join(STATE_DIR, "git");
export const PREVIEW_DIR = join(STATE_DIR, "snapshot-preview");

/** A compile that runs longer than this is stuck (an infinite loop in a macro, a runaway \loop). */
export const COMPILE_TIMEOUT_MS = 120_000;
/** Published builds kept per resume; older PDFs are deleted (the viewer only needs the latest few). */
export const KEEP_BUILDS = 4;

// TeX Live installs outside the default PATH of a GUI-launched or service process. Look in the usual places
// so the app works whether it was started from a terminal or not.
function texBinCandidates(): string[] {
  const dirs = ["/Library/TeX/texbin", join(homedir(), "Library/TinyTeX/bin/universal-darwin")];
  for (const base of ["/usr/local/texlive"]) {
    try {
      for (const year of readdirSync(/*turbopackIgnore: true*/ base).sort().reverse()) {
        for (const arch of ["universal-darwin", "x86_64-linux", "aarch64-linux"]) dirs.push(join(/*turbopackIgnore: true*/ base, year, "bin", arch));
      }
    } catch {
      // No TeX Live here.
    }
  }
  return dirs;
}

/** PATH for child processes: the inherited PATH plus any TeX and Homebrew bin dirs that exist. */
export function toolPath(): string {
  const extra = [...texBinCandidates(), "/opt/homebrew/bin", "/usr/local/bin"].filter((d) => existsSync(d));
  const current = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return [...new Set([...current, ...extra])].join(delimiter);
}

/** Absolute path of an executable on toolPath(), or null. */
export function findTool(name: string): string | null {
  for (const dir of toolPath().split(delimiter)) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}
