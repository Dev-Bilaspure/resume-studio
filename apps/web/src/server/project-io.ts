import "server-only";
import { randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TexServiceError } from "@resume-studio/tex-service";
import type { OutputFile, ProjectSymbols, WordCount } from "@/lib/types";
import { serviceSources } from "./compiler";
import { BUILD_DIR, RESUMES_DIR, STATE_DIR } from "./config";
import { HttpError, safeJoin, slugify } from "./fsutil";
import { run } from "./run";
import { serviceProject, texService, toolchainMode } from "./toolchain";
import { emptySymbols, scanBib, scanTex } from "./symbols";
import { META_FILE, createResumeFromFolder, listFiles, resumeDir } from "./workspace";

const MAX_ZIP_BYTES = 100_000_000;
const MAX_UNZIPPED_BYTES = 300_000_000;

// ---- Build output (Overleaf's "Logs and output files") ----------------------------------------------------

/** Files latexmk left in the build folder: the log, .blg, .aux, .bbl, .fls, … */
export async function listOutputFiles(id: string): Promise<OutputFile[]> {
  resumeDir(id);
  const dir = join(BUILD_DIR, id);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  // The build folder also holds the mirrored sources (see mirrorSources): list only what TeX made.
  const mirrored = new Set(Object.keys(JSON.parse(await readFile(join(dir, ".resume-studio-mirror.json"), "utf8").catch(() => "{}"))));
  const out: OutputFile[] = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.endsWith(".tmp") || e.name.startsWith(".") || mirrored.has(e.name)) continue;
    out.push({ name: e.name, size: (await stat(join(dir, e.name))).size });
  }
  const rank = (n: string) => (n.endsWith(".log") ? 0 : n.endsWith(".blg") ? 1 : n.endsWith(".pdf") ? 2 : 3);
  return out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

export async function readOutputFile(id: string, name: string): Promise<Buffer> {
  resumeDir(id);
  if (name.includes("/") || name.startsWith(".")) throw new HttpError(400, "Invalid file name");
  const full = safeJoin(join(BUILD_DIR, id), name);
  const st = await stat(full).catch(() => null);
  if (!st?.isFile()) throw new HttpError(404, `No output file "${name}"`);
  return readFile(full);
}

// ---- Project source as .zip -------------------------------------------------------------------------------

async function scratch(prefix: string) {
  const dir = join(STATE_DIR, "tmp", `${prefix}-${randomBytes(6).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** The resume's source files as a zip (what Overleaf's "Download → Source" gives you). */
export async function exportZip(id: string): Promise<Buffer> {
  const dir = resumeDir(id);
  const tmp = await scratch("export");
  const zipPath = join(tmp, "source.zip");
  try {
    const res = await run("zip", ["-r", "-X", "-q", zipPath, ".", "-x", META_FILE, "-x", "*.DS_Store", "-x", "*.tmp", "-x", ".git/*"], {
      cwd: dir,
      timeoutMs: 60_000,
    });
    if (res.code !== 0) throw new Error(`zip failed: ${res.stderr || res.stdout}`);
    return await readFile(zipPath);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Every path under `root`, with symlinks and total size: an untrusted archive must not escape or explode. */
async function auditTree(root: string): Promise<{ bytes: number }> {
  let bytes = 0;
  const realRoot = await realpath(root);
  async function walk(dir: string) {
    for (const e of await readdir(dir)) {
      const full = join(dir, e);
      const st = await lstat(full);
      if (st.isSymbolicLink()) {
        // Repositories link shared files (Awesome-CV's examples/awesome-cv.cls → ../awesome-cv.cls).
        // A link to a file inside the archive becomes a copy of it; any other link is dropped, so
        // nothing can point out of the project.
        const target = await realpath(full).catch(() => null);
        const inside = target !== null && target.startsWith(realRoot + "/");
        const isFile = inside && (await stat(target).catch(() => null))?.isFile();
        await rm(full, { force: true });
        if (isFile && target) {
          await copyFile(target, full);
          bytes += (await stat(full)).size;
        }
        continue;
      }
      if (st.isDirectory()) await walk(full);
      else bytes += st.size;
      if (bytes > MAX_UNZIPPED_BYTES) throw new HttpError(413, "The archive unpacks to more than 300 MB");
    }
  }
  await walk(root);
  return { bytes };
}

/**
 * Creates a resume from a project archive, e.g. Overleaf's Menu → Download → Source. If everything
 * sits in one top-level folder, that folder becomes the project root.
 */
export async function importZip(name: string, data: Buffer): Promise<string> {
  if (data.byteLength > MAX_ZIP_BYTES) throw new HttpError(413, "Archive too large (max 100 MB)");
  if (data.subarray(0, 2).toString("latin1") !== "PK") throw new HttpError(400, "That isn't a .zip file");
  const tmp = await scratch("import");
  try {
    const zipPath = join(tmp, "upload.zip");
    const out = join(tmp, "x");
    await writeFile(zipPath, data);
    await mkdir(out);
    // Info-ZIP strips leading "/" and refuses "../" components, so entries stay inside `out`.
    const res = await run("unzip", ["-q", "-o", zipPath, "-d", out, "-x", "__MACOSX/*", "*.DS_Store"], { timeoutMs: 120_000 });
    if (res.code !== 0 && res.code !== 1) throw new HttpError(400, `Couldn't unpack the archive: ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
    await auditTree(out);

    let root = out;
    const top = (await readdir(out)).filter((n) => !n.startsWith("."));
    if (top.length === 1 && (await stat(join(out, top[0]))).isDirectory()) root = join(out, top[0]);
    const hasTex = (await readdir(root, { recursive: true })).some((f) => /\.(tex|xtx|ltx)$/i.test(String(f)));
    if (!hasTex) throw new HttpError(400, "No .tex file in the archive");

    await rm(join(root, META_FILE), { force: true }); // ours, not the archive's
    return await createResumeFromFolder(name || slugify(top[0] ?? "imported"), async (dest) => {
      await mkdir(RESUMES_DIR, { recursive: true });
      await rename(root, dest);
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---- Word count (Overleaf's Menu → Word Count, which is texcount) ----------------------------------------

export async function wordCount(id: string, mainFile: string): Promise<WordCount> {
  const dir = resumeDir(id);
  let res: { stdout: string };
  if (toolchainMode() === "service") {
    // Counted on the compile service, in the same project the resume builds in.
    const project = serviceProject(join(BUILD_DIR, id));
    try {
      await texService().sync(project, await serviceSources(dir));
      res = await texService().texcount(project, mainFile);
    } catch (e) {
      if (e instanceof TexServiceError) throw new HttpError(503, e.message);
      throw e;
    }
  } else {
    const local = await run("texcount", ["-inc", "-total", "-merge", "-utf8", "-sum=1,1,1", mainFile], { cwd: dir, timeoutMs: 30_000 });
    if (local.error) throw new HttpError(503, "texcount isn't installed (it ships with TeX Live)");
    res = local;
  }
  const num = (label: string) => Number(new RegExp(`${label}:\\s*(\\d+)`).exec(res.stdout)?.[1] ?? 0);
  const text = num("Words in text");
  const headers = num("Words in headers");
  const captions = num("Words outside text \\(captions, etc\\.\\)");
  return { text, headers, captions, words: text + headers + captions, raw: res.stdout.trim() };
}

// ---- Project symbols for completion -----------------------------------------------------------------------

export async function projectSymbols(id: string): Promise<ProjectSymbols> {
  const root = resumeDir(id);
  const files = (await listFiles(id)).filter((f) => f.kind === "file");
  const out = emptySymbols();
  out.files = files.map((f) => f.path);
  await Promise.all(
    files
      .filter((f) => f.size < 2_000_000 && /\.(tex|sty|cls|bib)$/.test(f.path))
      .map(async (f) => {
        const src = await readFile(join(root, f.path), "utf8").catch(() => "");
        if (f.path.endsWith(".bib")) scanBib(f.path, src, out);
        else scanTex(f.path, src, out);
      }),
  );
  out.packages = [...new Set(out.packages)];
  out.environments = [...new Set(out.environments)];
  return out;
}
