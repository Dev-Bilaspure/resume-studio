import "server-only";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BUILD_DIR, findTool } from "./config";
import { publishedPath } from "./compiler";
import { HttpError, safeJoin } from "./fsutil";
import { parseSynctexEdit, parseSynctexView, type SyncBox } from "./synctex-parse";
import { run } from "./run";
import { resumeDir } from "./workspace";

export type { SyncBox };

function tool() {
  const t = findTool("synctex");
  if (!t) throw new HttpError(503, "synctex isn't installed (it ships with TeX Live)");
  return t;
}

function pdfFor(id: string, buildId: number) {
  const pdf = publishedPath(id, buildId, "pdf");
  if (!existsSync(pdf) || !existsSync(publishedPath(id, buildId, "synctex.gz"))) throw new HttpError(404, "No SyncTeX data for that build");
  return pdf;
}

/** Source line → boxes on the PDF page (top-left origin, PostScript points). */
export async function forwardSearch(id: string, buildId: number, file: string, line: number, column = 0): Promise<SyncBox[]> {
  // SyncTeX recorded the build folder's copies of the sources (see mirrorSources).
  resumeDir(id);
  const dir = join(BUILD_DIR, id);
  const abs = safeJoin(dir, file);
  const res = await run(tool(), ["view", "-i", `${line}:${column}:${abs}`, "-o", pdfFor(id, buildId)], { cwd: dir, timeoutMs: 10_000 });
  return parseSynctexView(res.stdout);
}

/** Point on a PDF page (top-left origin, points) → source file and line. */
export async function inverseSearch(
  id: string,
  buildId: number,
  page: number,
  x: number,
  y: number,
): Promise<{ file: string; line: number; column: number } | null> {
  resumeDir(id);
  const dir = join(BUILD_DIR, id);
  const res = await run(tool(), ["edit", "-o", `${page}:${x.toFixed(2)}:${y.toFixed(2)}:${pdfFor(id, buildId)}`], { cwd: dir, timeoutMs: 10_000 });
  return parseSynctexEdit(res.stdout, join(dir, "/"));
}
