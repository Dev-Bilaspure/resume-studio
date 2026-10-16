// Parsers for the `synctex` CLI output. Pure, so they can be unit tested.

export interface SyncBox {
  page: number;
  /** Left edge, from the page's left, in PostScript points (1/72 in). */
  h: number;
  /** Baseline, from the page's top, in points. */
  v: number;
  width: number;
  height: number;
}

/**
 * `synctex view` prints one record per box:
 *   SyncTeX result begin / Output:… / Page:1 / x:… / y:… / h:72.0 / v:100.2 / W:400.0 / H:9.8 / before: / …
 * x/y are the point synctex considers the match; h/v/W/H the enclosing box. We return the boxes.
 */
export function parseSynctexView(out: string): SyncBox[] {
  const boxes: SyncBox[] = [];
  let cur: Partial<Record<string, number>> = {};
  const flush = () => {
    if (cur.Page !== undefined && cur.h !== undefined && cur.v !== undefined) {
      boxes.push({ page: cur.Page, h: cur.h, v: cur.v, width: cur.W ?? 0, height: cur.H ?? 0 });
    }
    cur = {};
  };
  for (const line of out.split("\n")) {
    const m = /^(Page|x|y|h|v|W|H):(-?[\d.]+)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === "Page") flush();
    cur[m[1]] = Number(m[2]);
  }
  flush();
  // synctex may report the same box several times (one per matching node); keep distinct ones.
  const seen = new Set<string>();
  return boxes.filter((b) => {
    const k = `${b.page}:${b.h.toFixed(1)}:${b.v.toFixed(1)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** `synctex edit` prints Input:<path> / Line:<n> / Column:<n>. Returns the path relative to rootDir. */
export function parseSynctexEdit(out: string, rootDir: string): { file: string; line: number; column: number } | null {
  const get = (k: string) => new RegExp(`^${k}:(.*)$`, "m").exec(out)?.[1]?.trim();
  const input = get("Input");
  const line = Number(get("Line"));
  if (!input || !line) return null;
  let p = input.replace(/\/\.\//g, "/");
  const root = rootDir.endsWith("/") ? rootDir : rootDir + "/";
  if (p.startsWith(root)) p = p.slice(root.length);
  else if (p.startsWith("/")) return null; // a file outside the resume (a TeX Live package)
  while (p.startsWith("./")) p = p.slice(2);
  return { file: p, line, column: Math.max(0, Number(get("Column")) || 0) };
}
