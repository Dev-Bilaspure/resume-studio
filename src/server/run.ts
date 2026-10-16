import "server-only";
import { spawn } from "node:child_process";
import { toolPath } from "./config";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Spawn itself failed (executable missing). */
  error: NodeJS.ErrnoException | null;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  input?: string;
  /** Output beyond this is dropped (keeps the tail): a runaway TeX loop can print megabytes. */
  maxOutput?: number;
}

/**
 * Runs a program with an argument array (never through a shell), in its own process group so a
 * timeout kills it and everything it started (latexmk → pdflatex → bibtex).
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const max = opts.maxOutput ?? 2_000_000;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, PATH: toolPath(), ...opts.env },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killGroup();
        }, opts.timeoutMs)
      : null;
    const cap = (s: string) => (s.length > max ? s.slice(s.length - max) : s);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout = cap(stdout + d)));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr = cap(stderr + d)));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, error });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, error: null });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}
