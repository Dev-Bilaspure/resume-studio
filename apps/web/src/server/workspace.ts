import "server-only";
import { cp, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { z } from "zod";
import type { Engine, FileContent, FileEntry, ResumeMeta } from "@/lib/types";
import { BUILD_DIR, PUBLISH_DIR, RESUMES_DIR, STATE_DIR, TRASH_DIR } from "./config";
import { effectiveEngine, localDependencies, magicEngine, rankMainCandidates } from "./engine";
import { HttpError, atomicWrite, isJunk, safeJoin, sha256, slugify, toPosix } from "./fsutil";

export { effectiveEngine, magicEngine };

export const TEMPLATES_DIR = join(process.cwd(), "templates");
export const META_FILE = "resume.json";

const TEXT_EXT = new Set([
  ".tex",
  ".xtx",
  ".cls",
  ".sty",
  ".bib",
  ".bbx",
  ".cbx",
  ".txt",
  ".md",
  ".json",
  ".lua",
  ".cfg",
  ".def",
  ".clo",
  ".ltx",
  ".dtx",
  ".ins",
  ".yaml",
  ".yml",
  ".csv",
]);
const MAX_TEXT_BYTES = 2_000_000;
const MAX_UPLOAD_BYTES = 15_000_000;

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

const MetaSchema = z.object({
  name: z.string().min(1).max(120),
  engine: z.enum(["pdflatex", "xelatex", "lualatex", "latex"]).default("pdflatex"),
  trusted: z.boolean().default(false),
  haltOnError: z.boolean().default(false),
  application: z
    .object({
      company: z.string(),
      role: z.string(),
      link: z.string().optional(),
      baseResume: z.string(),
      session: z.string(),
      createdAt: z.string(),
      status: z.enum(["draft", "applied", "interviewing", "offer", "rejected", "withdrawn"]).default("draft"),
    })
    .optional(),
  mainFile: z.string().min(1).default("main.tex"),
  template: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export async function ensureDirs() {
  await Promise.all([RESUMES_DIR, STATE_DIR, BUILD_DIR, PUBLISH_DIR, TRASH_DIR].map((d) => mkdir(d, { recursive: true })));
}

export function resumeDir(id: string): string {
  if (!ID_RE.test(id) || id.startsWith(".")) throw new HttpError(400, "Invalid resume id");
  return safeJoin(RESUMES_DIR, id);
}

/** The main file of a folder without metadata: main.tex, else the best-ranked file with \documentclass. */
async function detectMainFile(dir: string): Promise<string | null> {
  if (existsSync(join(dir, "main.tex"))) return "main.tex";
  const files = (await readdir(dir, { recursive: true }).catch(() => [] as string[]))
    .map((f) => toPosix(String(f)))
    .filter((f) => /\.(tex|xtx|ltx)$/i.test(f) && f.split("/").length <= 5 && !/(^|\/)(\.git|node_modules)\//.test(f));
  const withClass: string[] = [];
  for (const f of files) {
    const src = await readFile(join(dir, f), "utf8").catch(() => "");
    if (/^[^%\n]*\\documentclass/m.test(src)) withClass.push(f);
  }
  return rankMainCandidates(withClass)[0] ?? null;
}

/**
 * The main file plus the project's own classes and packages it loads (searched next to the main file,
 * then at the root): what decides the engine and which fonts a document asks for.
 */
export async function projectPreamble(dir: string, mainFile: string): Promise<{ main: string; related: string[] }> {
  const main = (await readFile(join(dir, mainFile), "utf8").catch(() => "")).slice(0, 200_000);
  const { classes, packages } = localDependencies(main);
  const mainDir = mainFile.includes("/") ? mainFile.slice(0, mainFile.lastIndexOf("/")) : "";
  const candidates = [...classes.map((c) => `${c}.cls`), ...packages.map((p) => `${p}.sty`)].flatMap((f) => (mainDir ? [`${mainDir}/${f}`, f] : [f]));
  const related: string[] = [];
  for (const f of candidates) {
    if (/\.\.|^\//.test(f)) continue;
    const text = await readFile(join(dir, f), "utf8").catch(() => null);
    if (text !== null) related.push(text.slice(0, 200_000));
  }
  return { main, related };
}

/** The engine for a project folder (see effectiveEngine). */
export async function engineFor(dir: string, mainFile: string, configured: Engine): Promise<Engine> {
  const { main, related } = await projectPreamble(dir, mainFile);
  return effectiveEngine(main, configured, mainFile, related);
}

export async function getResume(id: string): Promise<ResumeMeta> {
  const dir = resumeDir(id);
  const st = await stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new HttpError(404, `No resume "${id}"`);
  let raw: unknown = null;
  try {
    raw = JSON.parse(await readFile(join(dir, META_FILE), "utf8"));
  } catch {
    // A folder made outside the app (or a broken resume.json): infer what we can.
  }
  const parsed = MetaSchema.safeParse(raw ?? {});
  const mainFile = parsed.success && existsSync(join(dir, parsed.data.mainFile)) ? parsed.data.mainFile : await detectMainFile(dir);
  return {
    id,
    name: parsed.success ? parsed.data.name : id,
    // What the compiler will use (a % !TEX program line, fontspec in the preamble or a project .cls…).
    engine: mainFile ? await engineFor(dir, mainFile, parsed.success ? parsed.data.engine : "pdflatex") : "pdflatex",
    mainFile: mainFile ?? "main.tex",
    template: parsed.success ? parsed.data.template : undefined,
    trusted: parsed.success ? parsed.data.trusted : false,
    haltOnError: parsed.success ? parsed.data.haltOnError : false,
    application: parsed.success ? parsed.data.application : undefined,
    createdAt: (parsed.success && parsed.data.createdAt) || st.birthtime.toISOString(),
    updatedAt: (parsed.success && parsed.data.updatedAt) || st.mtime.toISOString(),
  };
}

export async function listResumes(): Promise<ResumeMeta[]> {
  await ensureDirs();
  const entries = await readdir(RESUMES_DIR, { withFileTypes: true });
  const out: ResumeMeta[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name.startsWith("_") || !ID_RE.test(e.name)) continue;
    try {
      out.push(await getResume(e.name));
    } catch {
      // Unreadable folder: skip.
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function writeMeta(id: string, meta: Omit<ResumeMeta, "id">) {
  const { name, engine, mainFile, template, trusted, haltOnError, application, createdAt, updatedAt } = meta;
  await atomicWrite(
    join(resumeDir(id), META_FILE),
    JSON.stringify({ name, engine, mainFile, template, trusted, haltOnError, application, createdAt, updatedAt }, null, 2) + "\n",
  );
}

export async function touchResume(id: string) {
  const meta = await getResume(id);
  await writeMeta(id, { ...meta, updatedAt: new Date().toISOString() });
}

/**
 * A folder name that's free now and never used before: a deleted resume's snapshot history stays under
 * its id, so a new resume must not reuse the id of one in the trash.
 */
function uniqueId(base: string): string {
  const trashed = new Set((existsSync(TRASH_DIR) ? readdirSync(TRASH_DIR) : []).map((n) => n.replace(/-\d{4}-\d{2}-\d{2}T[\d-]+Z$/, "")));
  // "import" is an API route name (/api/resumes/import), never a resume id.
  let id = base === "import" ? "import-1" : base;
  for (let n = 2; existsSync(join(RESUMES_DIR, id)) || existsSync(join(BUILD_DIR, id)) || trashed.has(id); n++) id = `${base}-${n}`;
  return id;
}

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  engine: Engine;
}

export async function listTemplates(): Promise<TemplateInfo[]> {
  const dirs = await readdir(TEMPLATES_DIR, { withFileTypes: true }).catch(() => []);
  const out: (TemplateInfo & { order: number })[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    try {
      const t = JSON.parse(await readFile(join(TEMPLATES_DIR, d.name, "template.json"), "utf8"));
      out.push({ id: d.name, name: t.name, description: t.description, engine: t.engine ?? "pdflatex", order: t.order ?? 99 });
    } catch {
      // Not a template.
    }
  }
  return out.sort((a, b) => a.order - b.order).map((t) => ({ id: t.id, name: t.name, description: t.description, engine: t.engine }));
}

export async function createResume(input: { name: string; template?: string; duplicateOf?: string }): Promise<ResumeMeta> {
  await ensureDirs();
  const id = uniqueId(slugify(input.name));
  const dir = join(RESUMES_DIR, id);
  const now = new Date().toISOString();
  let engine: Engine = "pdflatex";
  let mainFile = "main.tex";
  let template: string | undefined;

  if (input.duplicateOf) {
    const src = await getResume(input.duplicateOf);
    await cp(resumeDir(src.id), dir, { recursive: true, filter: (p) => !isJunk(p.split("/").pop() ?? "") });
    engine = src.engine;
    mainFile = src.mainFile;
    template = src.template;
  } else {
    template = input.template ?? "classic";
    if (!/^[a-z0-9-]+$/.test(template)) throw new HttpError(400, "Invalid template");
    const tdir = join(TEMPLATES_DIR, template);
    if (!existsSync(tdir)) throw new HttpError(400, `No template "${template}"`);
    await cp(tdir, dir, { recursive: true, filter: (p) => !p.endsWith("template.json") });
    const t = (await listTemplates()).find((x) => x.id === template);
    engine = t?.engine ?? "pdflatex";
  }
  const prev = input.duplicateOf ? await getResume(input.duplicateOf) : null;
  await writeMeta(id, {
    name: input.name.trim(),
    engine,
    mainFile,
    template,
    trusted: prev?.trusted ?? false,
    haltOnError: prev?.haltOnError ?? false,
    createdAt: now,
    updatedAt: now,
  });
  return getResume(id);
}

/**
 * Creates a resume whose files are put in place by `populate(dest)` (an imported archive): a fresh id,
 * the main file detected, and the engine taken from the source (fontspec → XeLaTeX, % !TEX program).
 */
export async function createResumeFromFolder(name: string, populate: (dest: string) => Promise<void>): Promise<string> {
  await ensureDirs();
  const id = uniqueId(slugify(name));
  const dest = join(RESUMES_DIR, id);
  await populate(dest);
  const mainFile = (await detectMainFile(dest)) ?? "main.tex";
  const now = new Date().toISOString();
  await writeMeta(id, {
    name: name.trim() || id,
    engine: await engineFor(dest, mainFile, "pdflatex"),
    mainFile,
    trusted: false,
    haltOnError: false,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function updateResume(
  id: string,
  patch: { name?: string; engine?: Engine; mainFile?: string; trusted?: boolean; haltOnError?: boolean; application?: ResumeMeta["application"] },
): Promise<ResumeMeta> {
  const meta = await getResume(id);
  if (patch.mainFile) {
    const full = safeJoin(resumeDir(id), patch.mainFile);
    if (!existsSync(full) || !/\.(tex|xtx|ltx)$/i.test(patch.mainFile)) throw new HttpError(400, "The main file must be an existing .tex file");
  }
  const next = { ...meta, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), updatedAt: new Date().toISOString() };
  // Keep a "% !TEX program" line in the main file in step, so other editors build it the same way.
  if (patch.engine && patch.engine !== meta.engine) {
    const mainPath = safeJoin(resumeDir(id), next.mainFile);
    const src = await readFile(mainPath, "utf8").catch(() => null);
    if (src !== null && magicEngine(src)) {
      await atomicWrite(mainPath, src.replace(/^(%\s*!TEX\s+(?:TS-)?program\s*=\s*)\w+/im, `$1${patch.engine}`));
    }
  }
  await writeMeta(id, next);
  return getResume(id);
}

/** Moves the resume to .resume-studio/trash (recoverable by hand) and drops its build output. */
export async function trashResume(id: string): Promise<void> {
  const dir = resumeDir(id);
  if (!existsSync(dir)) throw new HttpError(404, `No resume "${id}"`);
  await mkdir(TRASH_DIR, { recursive: true });
  await rename(dir, join(TRASH_DIR, `${id}-${new Date().toISOString().replace(/[:.]/g, "-")}`));
  await rm(join(BUILD_DIR, id), { recursive: true, force: true });
  await rm(join(PUBLISH_DIR, id), { recursive: true, force: true });
}

// ---- Files ---------------------------------------------------------------------------------------------

function isEditable(path: string, size: number): boolean {
  return TEXT_EXT.has(extname(path).toLowerCase()) && size <= MAX_TEXT_BYTES;
}

export async function listFiles(id: string): Promise<FileEntry[]> {
  const root = resumeDir(id);
  const out: FileEntry[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > 8) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith(".") || isJunk(e.name)) continue;
      const full = join(dir, e.name);
      const rel = toPosix(relative(root, full));
      if (rel === META_FILE) continue;
      const st = await stat(full).catch(() => null);
      if (!st) continue;
      if (e.isDirectory()) {
        out.push({ path: rel, kind: "dir", size: 0, mtimeMs: st.mtimeMs, editable: false });
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        out.push({ path: rel, kind: "file", size: st.size, mtimeMs: st.mtimeMs, editable: isEditable(rel, st.size) });
      }
    }
  }
  await walk(root, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Text files of a resume as [relative, absolute] pairs (for ATS source checks and snapshots). */
export async function textFiles(id: string): Promise<[string, string][]> {
  const root = resumeDir(id);
  return (await listFiles(id)).filter((f) => f.kind === "file" && /\.(tex|cls|sty)$/.test(f.path)).map((f) => [f.path, join(root, f.path)]);
}

export async function readTextFile(id: string, path: string): Promise<FileContent> {
  const full = safeJoin(resumeDir(id), path);
  const st = await stat(full).catch(() => null);
  if (!st?.isFile()) throw new HttpError(404, `No file "${path}"`);
  if (!isEditable(path, st.size)) throw new HttpError(415, "Not a text file this editor opens");
  const content = await readFile(full, "utf8");
  return { path, content, hash: sha256(content), mtimeMs: st.mtimeMs };
}

export async function hashOnDisk(full: string): Promise<string | null> {
  try {
    return sha256(await readFile(full));
  } catch {
    return null;
  }
}

/**
 * Saves a text file. `baseHash` is the hash the editor loaded; if the file changed on disk since
 * (edited in another app, a restore), the save is refused with 409 so nothing is silently overwritten.
 */
export async function writeTextFile(id: string, path: string, content: string, baseHash: string | null): Promise<FileContent> {
  const full = safeJoin(resumeDir(id), path);
  if (!TEXT_EXT.has(extname(path).toLowerCase())) throw new HttpError(415, "Only text files can be saved from the editor");
  if (Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new HttpError(413, "File too large");
  if (baseHash !== null) {
    const current = await hashOnDisk(full);
    if (current !== null && current !== baseHash) {
      throw Object.assign(new HttpError(409, "The file changed on disk since you opened it"), { current });
    }
  }
  await atomicWrite(full, content);
  const st = await stat(full);
  return { path, content, hash: sha256(content), mtimeMs: st.mtimeMs };
}

export async function createEntry(id: string, path: string, kind: "file" | "dir", content = ""): Promise<void> {
  const full = safeJoin(resumeDir(id), path);
  if (existsSync(full)) throw new HttpError(409, `"${path}" already exists`);
  if (kind === "dir") await mkdir(full, { recursive: true });
  else await atomicWrite(full, content);
}

export async function uploadFile(id: string, path: string, data: Buffer): Promise<void> {
  if (data.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(413, "File too large (max 15 MB)");
  await atomicWrite(safeJoin(resumeDir(id), path), data);
}

export async function renameEntry(id: string, from: string, to: string): Promise<void> {
  const root = resumeDir(id);
  const a = safeJoin(root, from);
  const b = safeJoin(root, to);
  if (!existsSync(a)) throw new HttpError(404, `No file "${from}"`);
  if (existsSync(b)) throw new HttpError(409, `"${to}" already exists`);
  await mkdir(join(b, ".."), { recursive: true });
  await rename(a, b);
  const meta = await getResume(id);
  if (meta.mainFile === from) await writeMeta(id, { ...meta, mainFile: to, updatedAt: new Date().toISOString() });
}

export async function deleteEntry(id: string, path: string): Promise<void> {
  const full = safeJoin(resumeDir(id), path);
  const meta = await getResume(id);
  if (meta.mainFile === path) throw new HttpError(400, "That's the main file. Choose another main file first.");
  await rm(full, { recursive: true, force: true });
}

export async function readBinary(id: string, path: string): Promise<{ data: Buffer; size: number }> {
  const full = safeJoin(resumeDir(id), path);
  const st = await stat(full).catch(() => null);
  if (!st?.isFile()) throw new HttpError(404, `No file "${path}"`);
  return { data: await readFile(full), size: st.size };
}
