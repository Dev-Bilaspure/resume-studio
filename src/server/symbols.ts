// What the editor offers as completions across the whole project: \label names for \ref, .bib keys for
// \cite, user-defined commands and environments. Pure, so it can be unit tested.
import type { ProjectSymbols } from "../lib/types.ts";

function stripComments(src: string): string {
  return src
    .split("\n")
    .map((l) => l.replace(/(^|[^\\])%.*$/, "$1"))
    .join("\n");
}

function lineOf(src: string, index: number) {
  let n = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

export function scanTex(file: string, raw: string, into: ProjectSymbols) {
  const src = stripComments(raw);
  for (const m of src.matchAll(/\\label\s*\{([^}]+)\}/g)) into.labels.push({ name: m[1].trim(), file, line: lineOf(src, m.index) });
  for (const m of src.matchAll(/\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\*?\s*\{?\\([A-Za-z@]+)\}?\s*(?:\[(\d)\])?/g)) {
    into.commands.push({ name: m[1], args: Number(m[2] ?? 0) });
  }
  for (const m of src.matchAll(/\\(?:newenvironment|renewenvironment)\*?\s*\{([A-Za-z*@]+)\}/g)) into.environments.push(m[1]);
  for (const m of src.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    for (const p of m[1].split(",")) if (p.trim()) into.packages.push(p.trim());
  }
}

/** Entry keys and titles from a .bib file: @article{key, title = {…}, …}. */
export function scanBib(file: string, src: string, into: ProjectSymbols) {
  const re = /@(\w+)\s*[{(]\s*([^,\s]+)\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const type = m[1].toLowerCase();
    if (type === "comment" || type === "string" || type === "preamble") continue;
    const rest = src.slice(re.lastIndex, re.lastIndex + 2000);
    const title = /\btitle\s*=\s*[{"]([^}"]+)/i.exec(rest)?.[1]?.replace(/\s+/g, " ").trim();
    const author = /\bauthor\s*=\s*[{"]([^}"]+)/i.exec(rest)?.[1]?.replace(/\s+/g, " ").trim();
    into.citations.push({ key: m[2], type, title, author, file });
  }
}

export function emptySymbols(): ProjectSymbols {
  return { labels: [], citations: [], commands: [], environments: [], packages: [], files: [] };
}
