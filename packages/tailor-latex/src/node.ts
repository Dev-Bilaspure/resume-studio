// BuildVerifiers for use outside Resume Studio (the CLI, the MCP server, the evaluation harness, a
// standalone service): latexmkVerifier compiles drafts with the local TeX installation (TeX Live's
// latexmk and poppler's pdfinfo/pdftotext, on PATH or in the usual macOS/Linux locations);
// texServiceVerifier with the compile service; defaultVerifier picks.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import type { BuildCheck, BuildVerifier, SourceFiles } from "@resume-studio/tailor";
import { createTexServiceClient, DEFAULT_PORT, folderEntries, memoryEntries, METRIC_COMPATIBLE, substituteFont } from "@resume-studio/tex-service";
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

// The fonts' stand-ins are shared with the compile service.
export { METRIC_COMPATIBLE, substituteFont } from "@resume-studio/tex-service";

/** Fonts this machine turned out not to have (for the life of the process). */
const missingFonts = new Set<string>();

export function latexmkVerifier(options: LatexmkOptions = {}): BuildVerifier {
  const timeoutMs = options.timeoutMs ?? 120_000;
  return {
    async build(source, { maxPages, signal }): Promise<BuildCheck> {
      const work = mkdtempSync(join(tmpdir(), "tailor-build-"));
      try {
        if (options.assetsDir && existsSync(options.assetsDir)) cpSync(options.assetsDir, work, { recursive: true });
        const write = (files: Record<string, string>) => {
          for (const [path, text] of Object.entries(files)) {
            mkdirSync(dirname(join(work, path)), { recursive: true });
            writeFileSync(join(work, path), text);
          }
        };
        // Fonts already known to be missing here are swapped up front: looking one up and failing takes
        // fontspec ~10 s on a full TeX Live (it searches every installed font).
        let files = source.files;
        for (const f of missingFonts) files = substituteFont(files, f, METRIC_COMPATIBLE[f]);
        write(files);
        const base = source.main.replace(/\.[^.]+$/, "");
        const pdf = join(work, `${base}.pdf`);
        const compile = () => run("latexmk", [latexEngine(source), "-interaction=nonstopmode", "-file-line-error", "-halt-on-error", "-norc", "-g", source.main], { cwd: work, timeoutMs, signal });
        let tex = await compile();
        // A font the document names isn't installed here (Arial on Linux): check the layout with its
        // metric-compatible stand-in instead. Only this build's copy changes; the source stays as written.
        const substituted = new Set<string>();
        for (let i = 0; i < 3 && (tex.code !== 0 || !existsSync(pdf)); i++) {
          const log = existsSync(join(work, `${base}.log`)) ? readFileSync(join(work, `${base}.log`), "utf8") : "";
          const missing = /The font "([^"]+)" cannot be found/.exec(log)?.[1];
          const stand = missing && !substituted.has(missing) ? METRIC_COMPATIBLE[missing] : undefined;
          if (!missing || !stand) break;
          substituted.add(missing);
          missingFonts.add(missing);
          files = substituteFont(files, missing, stand);
          write(files);
          tex = await compile();
        }
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

// ---- The compile service -----------------------------------------------------------------------------------

export interface TexServiceVerifierOptions extends LatexmkOptions {
  /** The compile service, e.g. http://127.0.0.1:4380 (see packages/tex-service). */
  url: string;
  token?: string;
}

const BUILD_OUTPUT = /\.(aux|log|out|fls|fdb_latexmk|synctex\.gz|xdv|toc|bbl|blg|bcf|run\.xml)$/;
const ENGINE_OF = { "-pdf": "pdflatex", "-xelatex": "xelatex", "-lualatex": "lualatex" } as const;

/**
 * A BuildVerifier that compiles drafts on the compile service (TeX Live in a container) instead of a local
 * TeX installation. Drafts of one verifier share a project there, so each build uploads only what changed.
 */
export function texServiceVerifier(options: TexServiceVerifierOptions): BuildVerifier {
  const service = createTexServiceClient({ url: options.url, token: options.token });
  const project = `tailor-${randomBytes(8).toString("hex")}`;
  const timeoutMs = options.timeoutMs ?? 120_000;
  return {
    async build(source, { maxPages, signal }): Promise<BuildCheck> {
      // The resume folder's other files (images, fonts, classes), without what an earlier build left there.
      const include = (p: string, n: string) => !n.startsWith(".") && n !== "node_modules" && !(p in source.files) && !BUILD_OUTPUT.test(n);
      const assets = options.assetsDir && existsSync(options.assetsDir) ? await folderEntries(options.assetsDir, include) : [];
      await service.sync(project, [...assets, ...memoryEntries(source.files)], signal);
      const r = await service.compile(project, { main: source.main, engine: ENGINE_OF[latexEngine(source)], force: true, haltOnError: true, timeoutMs }, signal);
      if (r.code !== 0 || !r.pdf) {
        const errors = [...(r.log ?? "").matchAll(/^(?:\.\/)?([^:\n]+\.(?:tex|cls|sty)):(\d+): (.*)$/gm)].map((m) => ({ file: m[1], line: Number(m[2]), message: m[3] }));
        return { ok: false, pages: null, errors: errors.length ? errors : [{ message: (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || "The draft didn't compile" }] };
      }
      const pdf = Buffer.from(r.pdf, "base64");
      const { text, info } = await service.inspectPdf(pdf, { text: true, info: true });
      const pages = Number(/Pages:\s+(\d+)/.exec(info?.stdout ?? "")?.[1]) || null;
      let overflowLines: number | undefined;
      if (maxPages && pages && pages > maxPages) {
        const extra = await service.inspectPdf(pdf, { text: true, first: maxPages + 1, last: pages });
        overflowLines = (extra.text?.stdout ?? "").split("\n").filter((l) => l.trim()).length;
      }
      return { ok: true, pages, text: text?.stdout, overflowLines, errors: [] };
    },
    editAt: (draft, err) => latexAdapter.editAt(draft, err),
  };
}

/**
 * The verifier for this machine: the compile service when TAILOR_TEX_SERVICE_URL is set or TeX isn't
 * installed here (at its default address), otherwise local latexmk.
 */
export function defaultVerifier(options: LatexmkOptions = {}, env: NodeJS.ProcessEnv = process.env): BuildVerifier {
  const url = env.TAILOR_TEX_SERVICE_URL;
  if (url) return texServiceVerifier({ ...options, url, token: env.TAILOR_TEX_SERVICE_TOKEN || undefined });
  const hasLatexmk = [...(env.PATH ?? "").split(delimiter), ...EXTRA_PATH].some((d) => d && existsSync(join(d, "latexmk")));
  if (hasLatexmk) return latexmkVerifier(options);
  return texServiceVerifier({ ...options, url: `http://127.0.0.1:${DEFAULT_PORT}`, token: env.TAILOR_TEX_SERVICE_TOKEN || undefined });
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
