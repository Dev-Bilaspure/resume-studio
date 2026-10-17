// A BuildVerifier that compiles drafts with the local TeX installation (latexmk), for use outside
// Resume Studio: the CLI, the evaluation harness, a standalone service. Needs TeX Live (latexmk) and
// poppler (pdfinfo, pdftotext) on PATH or in the usual macOS/Linux locations.
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import type { BuildCheck, BuildVerifier, SourceFiles } from "@resume-studio/tailor";
import { latexAdapter } from "./latex.ts";

export interface LatexmkOptions {
  /** A folder whose other files (images, fonts, classes) the draft needs, copied in before its own files. */
  assetsDir?: string;
  /** Per-build limit. Default 120 s. */
  timeoutMs?: number;
}

const EXTRA_PATH = ["/Library/TeX/texbin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
const env = () => ({ ...process.env, PATH: [...(process.env.PATH ?? "").split(delimiter), ...EXTRA_PATH].filter(Boolean).join(delimiter) });

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal }) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, env: env(), timeout: opts.timeoutMs, signal: opts.signal, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** The engine a document needs: `% !TEX program`, then fontspec-style packages (XeLaTeX), else pdfLaTeX. */
export function latexEngine(source: SourceFiles): "-pdf" | "-xelatex" | "-lualatex" {
  const main = source.files[source.main] ?? "";
  const magic = /^%\s*!TEX\s+(?:TS-)?program\s*=\s*(\w+)/im.exec(main)?.[1]?.toLowerCase();
  if (magic === "xelatex") return "-xelatex";
  if (magic === "lualatex") return "-lualatex";
  if (magic === "pdflatex") return "-pdf";
  const all = Object.entries(source.files)
    .filter(([p]) => /\.(tex|cls|sty)$/.test(p))
    .map(([, t]) => t.replace(/(^|[^\\])%.*$/gm, "$1"))
    .join("\n");
  return /\\(usepackage|RequirePackage)(\[[^\]]*\])?\{[^}]*\b(fontspec|unicode-math|polyglossia)\b/.test(all) ? "-xelatex" : "-pdf";
}

export function latexmkVerifier(options: LatexmkOptions = {}): BuildVerifier {
  const timeoutMs = options.timeoutMs ?? 120_000;
  return {
    async build(source, { maxPages, signal }): Promise<BuildCheck> {
      const work = mkdtempSync(join(tmpdir(), "tailor-build-"));
      try {
        if (options.assetsDir && existsSync(options.assetsDir)) cpSync(options.assetsDir, work, { recursive: true });
        for (const [path, text] of Object.entries(source.files)) {
          mkdirSync(dirname(join(work, path)), { recursive: true });
          writeFileSync(join(work, path), text);
        }
        const tex = await run("latexmk", [latexEngine(source), "-interaction=nonstopmode", "-file-line-error", "-halt-on-error", "-norc", source.main], { cwd: work, timeoutMs, signal });
        const base = source.main.replace(/\.[^.]+$/, "");
        const pdf = join(work, `${base}.pdf`);
        if (tex.code !== 0 || !existsSync(pdf)) {
          const log = existsSync(join(work, `${base}.log`)) ? readFileSync(join(work, `${base}.log`), "utf8") : "";
          const errors = [...log.matchAll(/^(?:\.\/)?([^:\n]+\.(?:tex|cls|sty)):(\d+): (.*)$/gm)].map((m) => ({ file: m[1], line: Number(m[2]), message: m[3] }));
          return { ok: false, pages: null, errors: errors.length ? errors : [{ message: (tex.stderr || tex.stdout).trim().split("\n").slice(-3).join(" ") || "The draft didn't compile" }] };
        }
        const info = await run("pdfinfo", [pdf], { timeoutMs: 15_000 });
        const pages = Number(/Pages:\s+(\d+)/.exec(info.stdout)?.[1]) || null;
        const text = (await run("pdftotext", ["-enc", "UTF-8", pdf, "-"], { timeoutMs: 15_000 })).stdout;
        let overflowLines: number | undefined;
        if (maxPages && pages && pages > maxPages) {
          const extra = (await run("pdftotext", ["-f", String(maxPages + 1), "-l", String(pages), "-enc", "UTF-8", pdf, "-"], { timeoutMs: 15_000 })).stdout;
          overflowLines = extra.split("\n").filter((l) => l.trim()).length;
        }
        return { ok: true, pages, text, overflowLines, errors: [] };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    editAt: (draft, err) => latexAdapter.editAt(draft, err),
  };
}

// ---- Resume folders on disk ---------------------------------------------------------------------------------

/**
 * A LaTeX resume on disk: a folder (its main.tex, or the file with \documentclass) or a single .tex file.
 * Text files (.tex, .cls, .sty, .bib) become the engine's source; everything else stays in `dir` as assets.
 */
export function readResumeFolder(path: string): { dir: string; source: SourceFiles } {
  const p = resolve(path);
  if (!existsSync(p)) throw new Error(`No such file or folder: ${p}`);
  const isFile = statSync(p).isFile();
  const dir = isFile ? dirname(p) : p;
  const files: Record<string, string> = {};
  const walk = (d: string, depth: number) => {
    for (const n of readdirSync(d)) {
      if (n.startsWith(".") || n === "node_modules") continue;
      const f = join(d, n);
      const st = statSync(f);
      if (st.isDirectory() && depth < 4) walk(f, depth + 1);
      else if (st.isFile() && /\.(tex|cls|sty|bib)$/.test(n) && st.size < 2_000_000) files[relative(dir, f)] = readFileSync(f, "utf8");
    }
  };
  walk(dir, 0);
  const main = isFile ? basename(p) : "main.tex" in files ? "main.tex" : Object.keys(files).find((f) => f.endsWith(".tex") && /\\documentclass/.test(files[f]));
  if (!main || !(main in files)) throw new Error(`No LaTeX resume in ${p}: point to the main .tex file or its folder.`);
  return { dir, source: { main, files } };
}

/**
 * Writes a tailored resume as a new folder: the original folder's files (images, fonts, classes) first,
 * then the tailored text files over them, then any extra files (e.g. jd.md). Refuses to write over the
 * original or into a folder that isn't empty.
 */
export function writeResumeFolder(originalDir: string, outDir: string, source: SourceFiles, extra: Record<string, string> = {}): string {
  const out = resolve(outDir);
  if (out === resolve(originalDir)) throw new Error("Choose a new folder: the original resume is never overwritten.");
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} already exists and isn't empty.`);
  mkdirSync(out, { recursive: true });
  cpSync(originalDir, out, {
    recursive: true,
    filter: (src) => src === originalDir || (!/\/\.[^/]+$/.test(src) && !/\.(aux|log|out|fls|fdb_latexmk|synctex\.gz|xdv|toc|bbl|blg|bcf|run\.xml)$/.test(src)),
  });
  for (const [path, text] of Object.entries({ ...source.files, ...extra })) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), text);
  }
  return out;
}
