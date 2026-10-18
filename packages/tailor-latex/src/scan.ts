// Low-level LaTeX scanning: comments, balanced groups, arguments, and \input inlining with a map back to
// each file. Positions are character offsets; nothing here changes the source.

/** The source with comments blanked (same length), so analysis never matches inside a % comment. */
export function maskComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "%") {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Index of the brace closing the group that opens at `open` (src[open] must be "{" or "["). -1 if none. */
export function matchGroup(src: string, open: number): number {
  const o = src[open];
  const close = o === "{" ? "}" : o === "[" ? "]" : null;
  if (!close) return -1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === o) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    } else if (o === "[" && c === "{") {
      // Braces inside an optional argument: skip the whole group.
      const end = matchGroup(src, i);
      if (end < 0) return -1;
      i = end;
    }
  }
  return -1;
}

export interface Arg {
  kind: "opt" | "req";
  /** Content start/end (exclusive), without the delimiters. */
  start: number;
  end: number;
}

/** Arguments after position `at` (just after a command name): [opt]* {req}*, skipping spaces/newlines. */
export function readArgs(src: string, at: number, max = 9): { args: Arg[]; end: number } {
  const args: Arg[] = [];
  let i = at;
  while (args.length < max) {
    let j = i;
    while (j < src.length && /[ \t\n]/.test(src[j])) j++;
    // A blank line ends the argument list (a new paragraph).
    if (/\n[ \t]*\n/.test(src.slice(i, j))) break;
    const c = src[j];
    if (c !== "{" && c !== "[") break;
    const close = matchGroup(src, j);
    if (close < 0) break;
    args.push({ kind: c === "{" ? "req" : "opt", start: j + 1, end: close });
    i = close + 1;
  }
  return { args, end: i };
}

export interface Chunk {
  /** Range in the combined text. */
  cStart: number;
  cEnd: number;
  file: string;
  /** Where the chunk starts in its file. */
  fStart: number;
}

export interface Combined {
  text: string;
  masked: string;
  chunks: Chunk[];
  /** Files reached from the main file, in reading order. */
  files: string[];
}

/**
 * The document as one text with \input / \include / \subfile inlined (like TeX reads it), plus a map from
 * every combined offset back to its file. Unknown files are left as the command.
 */
export function combine(files: Record<string, string>, main: string): Combined {
  const chunks: Chunk[] = [];
  const reached: string[] = [];
  let text = "";

  const resolve = (from: string, name: string): string | null => {
    const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
    const candidates = [name, `${name}.tex`, `${dir}${name}`, `${dir}${name}.tex`].map((p) => p.replace(/^\.\//, ""));
    return candidates.find((p) => p in files) ?? null;
  };

  const visit = (file: string, depth: number) => {
    if (depth > 8 || reached.includes(file)) return;
    reached.push(file);
    const src = files[file];
    const masked = maskComments(src);
    const re = /\\(input|include|subfile)\s*\{([^}]+)\}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked))) {
      const target = resolve(file, m[2].trim());
      if (!target) continue;
      chunks.push({ cStart: text.length, cEnd: text.length + (m.index - last), file, fStart: last });
      text += src.slice(last, m.index);
      visit(target, depth + 1);
      last = m.index + m[0].length;
    }
    chunks.push({ cStart: text.length, cEnd: text.length + (src.length - last), file, fStart: last });
    text += src.slice(last);
  };
  visit(main, 0);
  return { text, masked: maskComments(text), chunks, files: reached };
}

/** A combined range → its file and in-file range. Null if the range crosses a file boundary. */
export function toFileRange(c: Combined, start: number, end: number): { file: string; start: number; end: number } | null {
  const chunk = c.chunks.find((k) => start >= k.cStart && end <= k.cEnd && k.cEnd > k.cStart);
  if (!chunk) {
    // An empty range at a chunk boundary (an insertion point) belongs to the chunk it starts.
    const at = c.chunks.find((k) => start >= k.cStart && start <= k.cEnd && end === start);
    if (!at) return null;
    return { file: at.file, start: at.fStart + (start - at.cStart), end: at.fStart + (start - at.cStart) };
  }
  return { file: chunk.file, start: chunk.fStart + (start - chunk.cStart), end: chunk.fStart + (end - chunk.cStart) };
}

/** 1-based line of an offset. */
export function lineAt(src: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}
