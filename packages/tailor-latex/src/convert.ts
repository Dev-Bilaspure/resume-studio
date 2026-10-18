// LaTeX ⇄ the engine's light markup (**bold**, *italic*, [text](url)). Only text that an edit replaces
// is ever generated; untouched LaTeX is never round-tripped.
import { matchGroup, readArgs } from "./scan.ts";

const BOLD = new Set(["textbf", "bf", "bfseries"]);
const ITALIC = new Set(["textit", "emph", "textsl", "it", "itshape"]);
/** Commands whose arguments are formatting, not text: dropped with their arguments. */
const DROP_WITH_ARGS: Record<string, number> = {
  color: 1,
  fontsize: 2,
  vspace: 1,
  "vspace*": 1,
  hspace: 1,
  "hspace*": 1,
  setlength: 2,
  includegraphics: 1,
  raisebox: 1,
  label: 1,
  rule: 2,
  definecolor: 3,
  pagestyle: 1,
  thispagestyle: 1,
  setcounter: 2,
  addtolength: 2,
  titlespacing: 4,
  "titlespacing*": 4,
  hypersetup: 1,
  addbibresource: 1,
};
/** Commands that print nothing (switches, spacing): dropped. */
const DROP = new Set([
  "selectfont", "small", "footnotesize", "scriptsize", "tiny", "normalsize", "large", "Large", "LARGE", "huge", "Huge",
  "centering", "raggedright", "raggedleft", "noindent", "hfill", "vfill", "par", "newline", "linebreak", "quad", "qquad",
  "enspace", "thinspace", "medskip", "smallskip", "bigskip", "normalfont", "rmfamily", "sffamily", "ttfamily", "mdseries",
  "upshape", "scshape", "unskip", "ignorespaces", "strut", "null", "relax", "protect", "leavevmode", "hline", "sep",
]);
const SYMBOLS: Record<string, string> = {
  textbar: "|", textbullet: "•", textendash: "–", textemdash: "—", ldots: "…", dots: "…", textasciitilde: "~",
  textbackslash: "\\", textdollar: "$", textpercent: "%", texttrademark: "™", textregistered: "®", copyright: "©",
  LaTeX: "LaTeX", TeX: "TeX", today: "", textless: "<", textgreater: ">",
};
const MATH: Record<string, string> = { to: "→", rightarrow: "→", leftarrow: "←", times: "×", approx: "≈", sim: "~", geq: "≥", leq: "≤", pm: "±", cdot: "·", mid: "|", "|": "|", infty: "∞" };

/**
 * LaTeX → light markup. \textbf → **…**, \textit/\emph → *…*, \href → [text](url), escapes and dashes
 * to characters; formatting commands vanish; other commands keep their text arguments.
 */
export function latexToMarkup(src: string): string {
  return tidy(walk(src, "markup"));
}

/** LaTeX → plain text (headings, header, context). */
export function latexToPlain(src: string): string {
  return tidy(walk(src, "plain"));
}

function tidy(s: string) {
  return s
    .replace(/\*\*\s*\*\*/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .trim();
}

function walk(src: string, mode: "markup" | "plain"): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "%") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === "\\") {
      const m = /^\\([A-Za-z@]+\*?|.)/.exec(src.slice(i));
      if (!m) {
        i++;
        continue;
      }
      const name = m[1];
      const after = i + m[0].length;
      // Escaped characters and spacing.
      if (name.length === 1 && !/[A-Za-z]/.test(name)) {
        out += name === "," || name === " " || name === ";" || name === ":" ? " " : name === "\\" ? " " : name === "-" ? "" : name;
        i = after;
        if (name === "\\") {
          // \\[2pt] line break with an optional skip
          const opt = /^\s*\[[^\]]*\]/.exec(src.slice(i));
          if (opt) i += opt[0].length;
        }
        continue;
      }
      if (name in SYMBOLS) {
        out += SYMBOLS[name];
        i = after;
        if (src[i] === "{" && src[i + 1] === "}") i += 2;
        continue;
      }
      if (DROP.has(name)) {
        i = after;
        continue;
      }
      // \hyphenpenalty=10000, \parskip=0pt: settings, not text.
      const assign = /^\s*=\s*[-\d.]+[a-z]*/.exec(src.slice(after));
      if (assign) {
        i = after + assign[0].length;
        continue;
      }
      if (name === "begin" || name === "end") {
        // \begin{tabularx}{\linewidth}{@{}X r@{}}: the environment and its arguments print nothing.
        const { end: argsEnd } = readArgs(src, after, name === "begin" ? 4 : 1);
        i = argsEnd;
        continue;
      }
      const { args, end } = readArgs(src, after);
      if (name in DROP_WITH_ARGS) {
        // \color[HTML]{xxx}: drop the optional and the required args.
        let n = DROP_WITH_ARGS[name];
        let j = after;
        for (const a of args) {
          if (a.kind === "opt") {
            j = a.end + 1;
            continue;
          }
          if (n-- <= 0) break;
          j = a.end + 1;
        }
        i = j;
        continue;
      }
      const req = args.filter((a) => a.kind === "req");
      if ((name === "href" || name === "hyperlink") && req.length >= 2) {
        const url = src.slice(req[0].start, req[0].end);
        const text = walk(src.slice(req[1].start, req[1].end), mode);
        out += mode === "markup" ? `[${text}](${url})` : text;
        i = req[1].end + 1;
        continue;
      }
      if (name === "url" && req.length) {
        out += src.slice(req[0].start, req[0].end);
        i = req[0].end + 1;
        continue;
      }
      if (name === "textcolor" && req.length >= 2) {
        out += walk(src.slice(req[1].start, req[1].end), mode);
        i = req[1].end + 1;
        continue;
      }
      if ((BOLD.has(name) || ITALIC.has(name)) && req.length && (name.startsWith("text") || name === "emph")) {
        const inner = walk(src.slice(req[0].start, req[0].end), mode).trim();
        const mark = mode === "plain" || !inner ? "" : BOLD.has(name) ? "**" : "*";
        out += `${mark}${inner}${mark}`;
        i = req[0].end + 1;
        continue;
      }
      if (BOLD.has(name) || ITALIC.has(name)) {
        // Switch form ({\bfseries x}): formatting dropped, text kept.
        i = after;
        continue;
      }
      if (name.startsWith("fa") && /^fa[A-Z]/.test(name)) {
        // FontAwesome icons print a glyph, no text.
        i = after;
        continue;
      }
      // Unknown command: keep the text of its required arguments.
      if (req.length) {
        out += req.map((a) => walk(src.slice(a.start, a.end), mode)).join(" ");
        i = end;
      } else {
        i = after;
      }
      continue;
    }
    if (c === "$") {
      // Inline math: symbols to characters, the rest as text.
      const close = src.indexOf("$", i + 1);
      if (close < 0) {
        out += "$";
        i++;
        continue;
      }
      const math = src.slice(i + 1, close).trim();
      const sym = /^\\([A-Za-z]+|\|)$/.exec(math);
      out += sym && MATH[sym[1]] ? MATH[sym[1]] : math.replace(/\\([A-Za-z]+)/g, (_, n) => MATH[n] ?? "").replace(/[{}^_]/g, "");
      i = close + 1;
      continue;
    }
    if (c === "{" || c === "}") {
      i++;
      continue;
    }
    if (c === "~") {
      out += " ";
      i++;
      continue;
    }
    if (src.startsWith("---", i)) {
      out += "—";
      i += 3;
      continue;
    }
    if (src.startsWith("--", i)) {
      out += "–";
      i += 2;
      continue;
    }
    if (src.startsWith("``", i)) {
      out += "“";
      i += 2;
      continue;
    }
    if (src.startsWith("''", i)) {
      out += "”";
      i += 2;
      continue;
    }
    if (c === "&") {
      out += " ";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Skips a balanced group starting at `i` if there is one; returns the index after it. */
export function skipGroup(src: string, i: number): number {
  if (src[i] !== "{") return i;
  const end = matchGroup(src, i);
  return end < 0 ? i : end + 1;
}

// ---- Markup → LaTeX -------------------------------------------------------------------------------------

const CHAR_MAP: [RegExp, string][] = [
  [/\\/g, "\\textbackslash{}"],
  [/([&%$#_{}])/g, "\\$1"],
  [/~/g, "\\textasciitilde{}"],
  [/\^/g, "\\textasciicircum{}"],
  [/—/g, "---"],
  [/–/g, "--"],
  [/→/g, "$\\rightarrow$"],
  [/←/g, "$\\leftarrow$"],
  [/×/g, "$\\times$"],
  [/≈/g, "$\\approx$"],
  [/≥/g, "$\\geq$"],
  [/≤/g, "$\\leq$"],
  [/±/g, "$\\pm$"],
  [/…/g, "\\ldots{}"],
  [/“/g, "``"],
  [/”/g, "''"],
];

function escapeText(s: string): string {
  let out = s;
  // Backslash first (so the backslashes we insert aren't escaped again).
  out = out.replace(/\\/g, "\u0000BS\u0000");
  for (const [re, rep] of CHAR_MAP.slice(1)) out = out.replace(re, rep);
  out = out.replace(/\u0000BS\u0000/g, "\\textbackslash{}");
  // Straight double quotes → TeX quotes.
  out = out.replace(/"([^"]*)"/g, "``$1''");
  return out;
}

/** Light markup → LaTeX, escaping everything else. */
export function markupToLatex(markup: string, style: { bold?: string; italic?: string } = {}): string {
  const bold = style.bold ?? "textbf";
  const italic = style.italic ?? "textit";
  let out = "";
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markup))) {
    out += escapeText(markup.slice(last, m.index));
    if (m[1] !== undefined) out += `\\href{${m[2].replace(/([%#\\])/g, "\\$1")}}{${escapeText(m[1])}}`;
    else if (m[3] !== undefined) out += `\\${bold}{${escapeText(m[3])}}`;
    else out += `\\${italic}{${escapeText(m[4])}}`;
    last = m.index + m[0].length;
  }
  out += escapeText(markup.slice(last));
  return out;
}
