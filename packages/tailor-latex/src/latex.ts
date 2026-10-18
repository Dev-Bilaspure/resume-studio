import { EditApplyError, type Edit, type EditOp, type FormatAdapter, type ResumeDoc, type Section, type SectionKind, type SourceFiles } from "@resume-studio/tailor";
import { latexToMarkup, latexToPlain, markupToLatex } from "./convert.ts";
import { combine, lineAt, maskComments, matchGroup, readArgs, toFileRange, type Combined } from "./scan.ts";

// ---- What the parser records about the source -------------------------------------------------------------

interface ItemSpan {
  id: string;
  listId: string;
  /** The item's whole text: "\item …" or "\resumeItem{…}" (combined offsets). */
  chunkStart: number;
  coreEnd: number;
  /** The editable text inside it. */
  contentStart: number;
  contentEnd: number;
}

interface ListSpan {
  id: string;
  items: ItemSpan[];
  /** End of the list's content (just before \end{itemize} or the list-end macro). */
  contentEnd: number;
}

interface Span {
  id: string;
  start: number;
  end: number;
}

export interface Parsed {
  doc: ResumeDoc;
  combined: Combined;
  lists: Map<string, ListSpan>;
  bullets: Map<string, ItemSpan>;
  skills: Map<string, Span & { label: string }>;
  paragraphs: Map<string, Span>;
  headline?: Span;
}

const SECTION_KIND: [RegExp, SectionKind][] = [
  [/summary|profile|objective|about|overview/i, "summary"],
  [/experience|employment|work|career|professional history/i, "experience"],
  [/project/i, "projects"],
  [/education|academic/i, "education"],
  [/skill|technolog|tools|stack|competenc|expertise/i, "skills"],
];

const ROLE_RE =
  /(?<![A-Za-z\\@./])((?:(?:Senior|Sr\.?|Staff|Principal|Lead|Junior|Jr\.?|Associate|Founding|Full[- ]?Stack|Back[- ]?[Ee]nd|Front[- ]?[Ee]nd|Software|Platform|Data|Machine Learning|ML|AI|Cloud|DevOps|Site Reliability|Mobile|iOS|Android|Systems?|Infrastructure|Security|Applied|Research|Product|Web|Embedded|Game|QA|Test|Solutions?)\s+){1,4}(?:Engineer|Developer|Architect|Scientist|SRE)(?:\s+(?:I{1,3}|IV|V))?)(?![A-Za-z])/;

/** \newcommand definitions that act as sections, list items, or list starts/ends. */
function scanMacros(masked: string) {
  const sectionMacros = new Set<string>();
  const itemMacros = new Set<string>();
  const listStart = new Set<string>();
  const listEnd = new Set<string>();
  const re = /\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z@]+)\}?\s*(?:\[(\d)\])?(?:\[[^\]]*\])?\s*(?=\{)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const open = m.index + m[0].length;
    const close = matchGroup(masked, open);
    if (close < 0) continue;
    const body = masked.slice(open + 1, close);
    const nargs = Number(m[2] ?? 0);
    // \cvsection{Title}: calls \section, or is named like one (Awesome-CV styles its own).
    if (nargs >= 1 && (/\\section\*?\s*\{/.test(body) || /section/i.test(m[1]))) sectionMacros.add(m[1]);
    else if (/\\item(?![A-Za-z])/.test(body) && nargs === 1 && /#1/.test(body) && !/\\begin\{/.test(body)) itemMacros.add(m[1]);
    else if (/\\begin\{(itemize|enumerate)\}/.test(body) && !/\\end\{(itemize|enumerate)\}/.test(body)) listStart.add(m[1]);
    else if (/\\end\{(itemize|enumerate)\}/.test(body) && !/\\begin\{(itemize|enumerate)\}/.test(body)) listEnd.add(m[1]);
  }
  // \newenvironment{cvitems}{…\begin{itemize}…}{…\end{itemize}…}: a list under another name.
  const listEnvs = new Set<string>();
  const envRe = /\\(?:re)?newenvironment\*?\s*\{([A-Za-z@*]+)\}\s*(?:\[\d\])?(?:\[[^\]]*\])?\s*(?=\{)/g;
  while ((m = envRe.exec(masked))) {
    const open = m.index + m[0].length;
    const close = matchGroup(masked, open);
    if (close >= 0 && /\\begin\{(itemize|enumerate)\}/.test(masked.slice(open, close))) listEnvs.add(m[1]);
  }
  return { sectionMacros, itemMacros, listStart, listEnd, listEnvs };
}

const alt = (names: Iterable<string>) => [...names].map((n) => n.replace(/[.*+?^${}()|[\]\\@]/g, "\\$&")).join("|");

// ---- Parse -----------------------------------------------------------------------------------------------

export function parseLatex(source: SourceFiles): Parsed {
  if (!(source.main in source.files)) throw new Error(`Main file ${source.main} isn't in the source`);
  const combined = combine(source.files, source.main);
  const T = combined.text;
  const M = combined.masked;
  // Macros may be defined in the project's own class or package (awesome-cv.cls defines \cvsection).
  const local = Object.entries(source.files)
    .filter(([f]) => /\.(cls|sty)$/.test(f))
    .map(([, t]) => maskComments(t));
  const macros = scanMacros([M, ...local].join("\n"));

  const docBegin = M.search(/\\begin\s*\{document\}/);
  const bodyStart = docBegin < 0 ? 0 : docBegin + M.slice(docBegin).indexOf("}") + 1;
  const docEnd = M.search(/\\end\s*\{document\}/);
  const bodyEnd = docEnd < 0 ? T.length : docEnd;

  // Sections: \section, \section*, and section-like macros (\cvsection…).
  const secNames = ["section\\*?", ...[...macros.sectionMacros].map((n) => n.replace(/@/g, "\\@"))];
  const secRe = new RegExp(`\\\\(${secNames.join("|")})(?![A-Za-z@])`, "g");
  const heads: { start: number; titleStart: number; titleEnd: number; after: number }[] = [];
  secRe.lastIndex = bodyStart;
  let m: RegExpExecArray | null;
  while ((m = secRe.exec(M)) && m.index < bodyEnd) {
    const { args } = readArgs(M, m.index + m[0].length, 2);
    const title = args.find((a) => a.kind === "req");
    if (!title) continue;
    heads.push({ start: m.index, titleStart: title.start, titleEnd: title.end, after: title.end + 1 });
  }

  const lists = new Map<string, ListSpan>();
  const bullets = new Map<string, ItemSpan>();
  const skills = new Map<string, Span & { label: string }>();
  const paragraphs = new Map<string, Span>();
  const sections: Section[] = [];
  let nList = 0;
  let nBullet = 0;
  let nSkill = 0;
  let nPara = 0;

  const headerEnd = heads[0]?.start ?? bodyEnd;
  heads.forEach((h, i) => {
    const end = heads[i + 1]?.start ?? bodyEnd;
    const title = latexToPlain(T.slice(h.titleStart, h.titleEnd));
    const kind = SECTION_KIND.find(([re]) => re.test(title))?.[1] ?? "other";
    const section: Section = { id: `sec${i + 1}`, kind, title, lists: [], skills: [], context: "" };

    const envs = kind === "skills" ? [] : findLists(M, h.after, end, macros);
    let cursor = h.after;
    const contextParts: string[] = [];
    for (const env of envs) {
      const items = itemsOf(M, T, env, macros);
      const heading = latexToPlain(T.slice(cursor, env.begin)).slice(0, 240);
      contextParts.push(heading);
      cursor = env.end;
      if (!items.length) continue;
      const listId = `l${++nList}`;
      const span: ListSpan = { id: listId, items: [], contentEnd: env.contentEnd };
      const docList = { id: listId, heading, bullets: [] as { id: string; text: string }[] };
      for (const it of items) {
        const id = `b${++nBullet}`;
        const item: ItemSpan = { ...it, id, listId };
        span.items.push(item);
        bullets.set(id, item);
        docList.bullets.push({ id, text: latexToMarkup(T.slice(it.contentStart, it.contentEnd)) });
      }
      lists.set(listId, span);
      section.lists.push(docList);
    }
    contextParts.push(latexToPlain(T.slice(cursor, end)));

    if (kind === "skills") {
      for (const line of skillLines(M, T, h.after, end)) {
        const id = `s${++nSkill}`;
        skills.set(id, { id, start: line.start, end: line.end, label: line.label });
        section.skills.push({ id, label: line.label, text: latexToMarkup(T.slice(line.start, line.end)) });
      }
    }
    if (kind === "summary" && !envs.length) {
      const [s, e] = trimRange(M, h.after, end);
      const text = latexToMarkup(T.slice(s, e));
      if (text && text.length < 1500) {
        const id = `p${++nPara}`;
        paragraphs.set(id, { id, start: s, end: e });
        section.paragraph = { id, text };
      }
    }
    section.context = contextParts.join(" ").replace(/\s+/g, " ").trim().slice(0, 600);
    sections.push(section);
  });

  // The headline: the role line in the header ("Software Engineer").
  let headline: Span | undefined;
  const hm = ROLE_RE.exec(M.slice(bodyStart, headerEnd));
  if (hm) {
    const start = bodyStart + hm.index + (hm[0].length - hm[1].length);
    headline = { id: "h1", start, end: start + hm[1].length };
  }

  const doc: ResumeDoc = {
    header: latexToPlain(T.slice(bodyStart, headerEnd)).slice(0, 500),
    headline: headline ? { id: headline.id, text: T.slice(headline.start, headline.end) } : undefined,
    sections,
    plainText: latexToPlain(T.slice(bodyStart, bodyEnd)),
  };
  return { doc, combined, lists, bullets, skills, paragraphs, headline };
}

interface Env {
  begin: number; // start of \begin{itemize} (or the start macro)
  contentStart: number;
  contentEnd: number; // start of \end{itemize}
  end: number; // after \end{itemize}
  children: Env[];
}

/** Top-level list environments in [from, to), with their nested lists. */
function findLists(M: string, from: number, to: number, macros: ReturnType<typeof scanMacros>): Env[] {
  const starts = macros.listStart.size ? `|\\\\(?:${alt(macros.listStart)})(?![A-Za-z@])` : "";
  const ends = macros.listEnd.size ? `|\\\\(?:${alt(macros.listEnd)})(?![A-Za-z@])` : "";
  const envNames = ["itemize", "enumerate", ...[...macros.listEnvs].map((n) => n.replace(/[*@]/g, "\\$&"))].join("|");
  const re = new RegExp(`(\\\\begin\\s*\\{(?:${envNames})\\}(?:\\s*\\[[^\\]]*\\])?${starts})|(\\\\end\\s*\\{(?:${envNames})\\}${ends})`, "g");
  re.lastIndex = from;
  const roots: Env[] = [];
  const stack: Env[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(M)) && m.index < to) {
    if (m[1]) {
      const env: Env = { begin: m.index, contentStart: m.index + m[0].length, contentEnd: -1, end: -1, children: [] };
      (stack.at(-1)?.children ?? roots).push(env);
      stack.push(env);
    } else {
      const env = stack.pop();
      if (!env) continue;
      env.contentEnd = m.index;
      env.end = m.index + m[0].length;
    }
  }
  // Unclosed lists (a typo in the source) end where the section ends.
  const fix = (envs: Env[]) =>
    envs.forEach((e) => {
      if (e.contentEnd < 0) {
        e.contentEnd = to;
        e.end = to;
      }
      fix(e.children);
    });
  fix(roots);
  // Lists that contain lists (Jake's \resumeSubHeadingListStart): their inner lists hold the bullets.
  const flat: Env[] = [];
  const walk = (e: Env) => {
    if (e.children.length) e.children.forEach(walk);
    else flat.push(e);
  };
  roots.forEach(walk);
  return flat;
}

/** The bullets directly in a list: \item … and item macros (\resumeItem{…}). */
function itemsOf(M: string, T: string, env: Env, macros: ReturnType<typeof scanMacros>): Omit<ItemSpan, "id" | "listId">[] {
  const itemMacro = macros.itemMacros.size ? `|\\\\(?:${alt(macros.itemMacros)})(?![A-Za-z@])` : "";
  const re = new RegExp(`\\\\item(?![A-Za-z@])${itemMacro}`, "g");
  const marks: { start: number; tokenEnd: number; macro: boolean }[] = [];
  re.lastIndex = env.contentStart;
  let m: RegExpExecArray | null;
  while ((m = re.exec(M)) && m.index < env.contentEnd) marks.push({ start: m.index, tokenEnd: m.index + m[0].length, macro: m[0] !== "\\item" });

  const out: Omit<ItemSpan, "id" | "listId">[] = [];
  marks.forEach((mk, i) => {
    const limit = marks[i + 1]?.start ?? env.contentEnd;
    if (mk.macro) {
      const { args } = readArgs(M, mk.tokenEnd, 1);
      const a = args[0];
      if (!a || a.kind !== "req" || a.end > limit) return;
      const [s, e] = trimRange(M, a.start, a.end);
      if (s >= e) return;
      out.push({ chunkStart: mk.start, coreEnd: a.end + 1, contentStart: s, contentEnd: e });
      return;
    }
    // \item[label] text… up to the next item or the end of the list.
    let p = mk.tokenEnd;
    const opt = /^\s*\[[^\]]*\]/.exec(M.slice(p, limit));
    if (opt) p += opt[0].length;
    const [s, e] = trimRange(M, p, limit);
    if (s >= e) return;
    out.push({ chunkStart: mk.start, coreEnd: e, contentStart: s, contentEnd: e });
  });
  return out;
}

/** "Languages: Go, Python" lines in a skills section; the span is the items after the label. */
function skillLines(M: string, T: string, from: number, to: number): { label: string; start: number; end: number }[] {
  const out: { label: string; start: number; end: number }[] = [];
  // \cvskill{Languages}{Go, Python} / \cvitem{Languages}{Go, Python}: a label and a comma-separated list.
  const pair = /\\([A-Za-z@]+)\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]{1,40})\}\s*(?=\{)/g;
  pair.lastIndex = from;
  let pm: RegExpExecArray | null;
  while ((pm = pair.exec(M)) && pm.index < to) {
    if (/^(textbf|textit|emph|textsc|section|href|textcolor|color|begin|end|hspace|vspace)$/.test(pm[1])) continue;
    const open = pm.index + pm[0].length;
    const close = matchGroup(M, open);
    if (close < 0 || close > to) continue;
    const [s0, e0] = trimRange(M, open + 1, close);
    if (s0 < e0 && /,/.test(T.slice(s0, e0)) && !/\\begin\{/.test(M.slice(s0, e0))) out.push({ label: latexToPlain(pm[2]), start: s0, end: e0 });
    pair.lastIndex = close;
  }
  if (out.length) return out;
  const labelRe = /\\(?:textbf|textsc|emph|textit)\s*\{([^{}]{1,40}?)\}/g;
  labelRe.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = labelRe.exec(M)) && m.index < to) {
    let label = m[1].trim();
    let p = m.index + m[0].length;
    let itemsStart = -1;
    let groupEnd = -1;
    const ws = /^\s*/.exec(M.slice(p))![0].length;
    if (label.endsWith(":")) {
      label = label.slice(0, -1).trim();
      itemsStart = p;
    } else if (M[p + ws] === ":") {
      itemsStart = p + ws + 1;
    } else if (M[p + ws] === "{" && /^\{\s*:/.test(M.slice(p + ws))) {
      // Jake's resume: \textbf{Languages}{: Java, Python}
      groupEnd = matchGroup(M, p + ws);
      itemsStart = p + ws + 1 + /^\{\s*:/.exec(M.slice(p + ws))![0].length - 1;
    } else continue;
    const end = groupEnd >= 0 ? groupEnd : lineEnd(M, itemsStart, to);
    const [s, e] = trimRange(M, itemsStart, end);
    if (s < e && label.length <= 40) out.push({ label: latexToPlain(label), start: s, end: e });
    labelRe.lastIndex = Math.max(labelRe.lastIndex, end);
  }
  if (out.length) return out;
  // No bold labels: "Label: items" lines separated by \\, \par or blank lines.
  const body = M.slice(from, to);
  const parts = body.split(/(\\\\(?:\[[^\]]*\])?|\\par\b|\n\s*\n)/);
  let off = from;
  for (const part of parts) {
    const colon = part.indexOf(":");
    if (colon > 0 && colon < 40 && !/\\(begin|end|section)/.test(part)) {
      const label = latexToPlain(part.slice(0, colon));
      const [s, e] = trimRange(M, off + colon + 1, off + part.length);
      if (label && label.split(/\s+/).length <= 5 && s < e) out.push({ label, start: s, end: e });
    }
    off += part.length;
  }
  return out;
}

/** Where a skills line ends: a line break (\\, \par, blank line), the next label, or a closing brace. */
function lineEnd(M: string, from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = M[i];
    if (c === "\\") {
      if (M.startsWith("\\\\", i) || /^\\par(?![A-Za-z])/.test(M.slice(i, i + 5)) || /^\\(textbf|item)(?![A-Za-z])/.test(M.slice(i, i + 8))) {
        if (depth === 0) return i;
      }
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (c === "\n" && /^\n\s*\n/.test(M.slice(i, i + 4)) && depth === 0) return i;
  }
  return to;
}

/**
 * Trims whitespace and comments off a range. `T` should be the comment-masked text (comments are
 * spaces there), so a trailing "% ---- Experience" line stays outside the span and survives an edit.
 */
function trimRange(T: string, start: number, end: number): [number, number] {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(T[s])) s++;
  while (e > s && /\s/.test(T[e - 1])) e--;
  // A trailing line break (\\ or \\[2pt]) belongs to the layout, not the text.
  const tail = /\\\\(\[[^\]]*\])?\s*$/.exec(T.slice(s, e));
  if (tail) {
    e -= tail[0].length;
    while (e > s && /\s/.test(T[e - 1])) e--;
  }
  return [s, e];
}

// ---- Apply -----------------------------------------------------------------------------------------------

export interface EditLocation {
  file: string;
  startLine: number;
  endLine: number;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
  editIds: string[];
}

/** Applies edits; also reports where each edit landed in the output (for mapping build errors back). */
export function applyLatex(source: SourceFiles, edits: Pick<Edit, "id" | "change">[]): { source: SourceFiles; locations: Map<string, EditLocation> } {
  const p = parseLatex(source);
  const T = p.combined.text;
  const reps: Replacement[] = [];
  const bold = "textbf";

  // Lists: every list edit at once, by rebuilding the list from its items.
  const byList = new Map<string, Pick<Edit, "id" | "change">[]>();
  for (const e of edits) {
    const c = e.change;
    let listId: string | undefined;
    if (c.op === "rewrite_bullet" || c.op === "remove_bullet") listId = p.bullets.get(c.target)?.listId;
    else if (c.op === "add_bullet" || c.op === "reorder_bullets") listId = p.lists.has(c.target) ? c.target : undefined;
    else continue;
    if (!listId) throw new EditApplyError(e.id, `unknown target ${c.target}`);
    byList.set(listId, [...(byList.get(listId) ?? []), e]);
  }
  for (const [listId, listEdits] of byList) reps.push(rebuildList(T, p.lists.get(listId)!, listEdits, bold));

  for (const e of edits) {
    const c = e.change;
    if (c.op === "rewrite_paragraph") {
      const s = p.paragraphs.get(c.target);
      if (!s) throw new EditApplyError(e.id, `unknown paragraph ${c.target}`);
      reps.push({ start: s.start, end: s.end, text: markupToLatex(c.text, { bold }), editIds: [e.id] });
    } else if (c.op === "rewrite_skills") {
      const s = p.skills.get(c.target);
      if (!s) throw new EditApplyError(e.id, `unknown skills line ${c.target}`);
      // The model sometimes repeats the label ("Languages: Go, …"): the label stays where it is.
      const text = c.text.replace(new RegExp(`^\\s*\\**${s.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\**\\s*:\\s*`, "i"), "");
      reps.push({ start: s.start, end: s.end, text: markupToLatex(text, { bold }), editIds: [e.id] });
    } else if (c.op === "set_headline") {
      if (!p.headline || p.headline.id !== c.target) throw new EditApplyError(e.id, "no headline to change");
      reps.push({ start: p.headline.start, end: p.headline.end, text: markupToLatex(c.text.replace(/\*+/g, "")), editIds: [e.id] });
    }
  }

  // Combined ranges → per-file replacements, applied from the end so offsets stay valid.
  const perFile = new Map<string, (Replacement & { fStart: number; fEnd: number })[]>();
  for (const r of reps) {
    const fr = toFileRange(p.combined, r.start, r.end);
    if (!fr) throw new EditApplyError(r.editIds[0], "the edit spans more than one file");
    perFile.set(fr.file, [...(perFile.get(fr.file) ?? []), { ...r, fStart: fr.start, fEnd: fr.end }]);
  }
  const files = { ...source.files };
  const locations = new Map<string, EditLocation>();
  for (const [file, list] of perFile) {
    list.sort((a, b) => a.fStart - b.fStart);
    for (let i = 1; i < list.length; i++) if (list[i].fStart < list[i - 1].fEnd) throw new EditApplyError(list[i].editIds[0], "overlaps another edit");
    let src = files[file];
    let delta = 0;
    for (const r of list) {
      const at = r.fStart + delta;
      src = src.slice(0, at) + r.text + src.slice(r.fEnd + delta);
      const loc = { file, startLine: lineAt(src, at), endLine: lineAt(src, at + r.text.length) };
      for (const id of r.editIds) locations.set(id, loc);
      delta += r.text.length - (r.fEnd - r.fStart);
    }
    files[file] = src;
  }
  return { source: { main: source.main, files }, locations };
}

function rebuildList(T: string, list: ListSpan, edits: Pick<Edit, "id" | "change">[], bold: string): Replacement {
  const items = list.items;
  // Each original item's text and the whitespace that follows it.
  const cores = items.map((it) => T.slice(it.chunkStart, it.coreEnd));
  const seps = items.map((it, i) => T.slice(it.coreEnd, items[i + 1]?.chunkStart ?? list.contentEnd));
  const lastSep = seps.at(-1) ?? "\n";
  const innerSep = seps.length > 1 ? seps[0] : `\n${indentOf(T, items[0].chunkStart)}`;

  type Slot = { core: string };
  const content = new Map<string, Slot>(items.map((it, i) => [it.id, { core: cores[i] }]));
  let sequence: string[] = items.map((it) => it.id);
  const template = (refId: string | null) => items.find((it) => it.id === refId) ?? items[0];

  for (const e of edits) {
    const c = e.change as EditOp;
    switch (c.op) {
      case "rewrite_bullet": {
        const it = items.find((x) => x.id === c.target)!;
        content.set(it.id, { core: T.slice(it.chunkStart, it.contentStart) + markupToLatex(c.text, { bold }) + T.slice(it.contentEnd, it.coreEnd) });
        break;
      }
      case "remove_bullet":
        sequence = sequence.filter((id) => id !== c.target);
        break;
      case "add_bullet": {
        const ref = template(c.after);
        const id = `new-${e.id}`;
        content.set(id, { core: T.slice(ref.chunkStart, ref.contentStart) + markupToLatex(c.text, { bold }) + T.slice(ref.contentEnd, ref.coreEnd) });
        const at = c.after ? sequence.indexOf(c.after) + 1 : 0;
        if (c.after && at === 0) throw new EditApplyError(e.id, `bullet ${c.after} isn't in this list`);
        sequence.splice(at, 0, id);
        break;
      }
      case "reorder_bullets": {
        const rank = new Map(c.order.map((id, i) => [id, i]));
        const originals = sequence.filter((id) => rank.has(id)).sort((a, b) => rank.get(a)! - rank.get(b)!);
        // New bullets keep their position relative to the originals they follow.
        const rebuilt: string[] = [];
        for (const id of originals) {
          rebuilt.push(id);
          for (let i = sequence.indexOf(id) + 1; i < sequence.length && !rank.has(sequence[i]); i++) rebuilt.push(sequence[i]);
        }
        const leading = sequence.slice(0, sequence.findIndex((id) => rank.has(id)));
        sequence = [...leading, ...rebuilt];
        break;
      }
    }
  }
  if (!sequence.length) throw new EditApplyError(edits[0].id, "would leave the list empty");
  const text = sequence.map((id, i) => content.get(id)!.core + (i === sequence.length - 1 ? lastSep : i < seps.length - 1 ? seps[i] : innerSep)).join("");
  return { start: items[0].chunkStart, end: list.contentEnd, text, editIds: edits.map((e) => e.id) };
}

function indentOf(T: string, at: number): string {
  const lineStart = T.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*/.exec(T.slice(lineStart, at))![0];
}

// ---- The adapter ------------------------------------------------------------------------------------------

/** Where edits landed in drafts made by this adapter (for mapping build errors back to an edit). */
const draftLocations = new WeakMap<SourceFiles, Map<string, EditLocation>>();

export const latexAdapter: FormatAdapter & {
  editAt(draft: SourceFiles, error: { file?: string; line?: number }): string | null;
} = {
  format: "latex",
  parse: (source) => parseLatex(source).doc,
  apply(source, _doc, edits) {
    const { source: out, locations } = applyLatex(source, edits);
    draftLocations.set(out, locations);
    return out;
  },
  editAt(draft, error) {
    const locs = draftLocations.get(draft);
    if (!locs || !error.line) return null;
    for (const [id, l] of locs) {
      if ((!error.file || error.file === l.file || error.file.endsWith(`/${l.file}`)) && error.line >= l.startLine && error.line <= l.endLine) return id;
    }
    return null;
  },
};
