// Parses a TeX .log into editor diagnostics. Pure (no I/O) so it can be unit tested.
//
// The compiler runs TeX with -file-line-error and max_print_line=10000, so errors look like
// "./main.tex:42: Undefined control sequence." and long lines are not wrapped at 79 columns. Warnings
// don't carry a file name, only "on input line N"; for those the parser tracks which file is open from
// the "(./file.tex ... )" nesting that TeX writes as it reads files.
import type { Diagnostic } from "../lib/types.ts";

const basename = (p: string) => p.split("/").pop() ?? p;

const FILE_LINE_ERROR = /^((?:\.{1,2}\/|\/)[^:]*?|[^\s:/][^:]*?\.(?:tex|sty|cls|bib|bbl|aux|def|cfg|clo|fd|ltx|dtx)):(\d+): (.*)$/;
const BOX = /^(Overfull|Underfull) \\([hv])box \(([^)]*)\)(?:.*?(?:at lines? (\d+)(?:--(\d+))?|detected at line (\d+)))?/;
const INPUT_LINE = /on input line (\d+)/;

export interface ParseOptions {
  /** Absolute path of the project folder (or its build mirror). */
  rootDir: string;
  /** TeX's working directory relative to rootDir: the main file's folder ("" or "." for the root). */
  cwd?: string;
}

/** Resolves "a/./b/../c" to "a/c"; null if it climbs out of the project. */
function normalizeRel(p: string): string | null {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/") || null;
}

/** Path relative to the project folder, or null for files elsewhere (TeX Live packages). */
function relFile(raw: string | undefined, rootDir: string, cwd = ""): string | null {
  if (!raw) return null;
  const p = raw.trim().replace(/^"|"$/g, "");
  const root = rootDir.endsWith("/") ? rootDir : rootDir + "/";
  if (p.startsWith(root)) return normalizeRel(p.slice(root.length)); // also "<root>/./main.tex"
  if (p.startsWith("/")) return null;
  // Relative paths are relative to TeX's working directory, the main file's folder.
  return normalizeRel(cwd && cwd !== "." ? `${cwd}/${p}` : p);
}

/**
 * Tracks the stack of files TeX has open. On each line, "(" followed by something path-like opens a
 * file and ")" closes the innermost one. Parentheses in ordinary text ("(see the transcript file)")
 * aren't path-like, so they are ignored on open; a stray ")" can pop too early, which only costs a
 * wrong file guess for a warning, never a missed diagnostic.
 */
class FileStack {
  private stack: string[] = [];
  private static OPEN = /^\(("[^"]+"|(?:\.{0,2}\/)?[^\s()"{}[\]]+\.[A-Za-z0-9]+)/;

  feed(line: string) {
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "(") {
        const m = FileStack.OPEN.exec(line.slice(i));
        if (m) {
          this.stack.push(m[1]);
          i += m[0].length - 1;
        } else {
          this.stack.push(""); // non-file paren: keeps ")" balanced
        }
      } else if (c === ")") {
        this.stack.pop();
      }
    }
  }

  current(): string | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) if (this.stack[i]) return this.stack[i];
    return undefined;
  }
}

function errorHint(message: string): string | undefined {
  const missing = /File [`'"](.+?)' not found/.exec(message);
  if (missing) {
    return `${missing[1]} isn't installed. With MacTeX (full TeX Live) every CTAN package is present; with a smaller install run: tlmgr install ${missing[1].replace(/\.(sty|cls)$/, "")}`;
  }
  if (/Undefined control sequence/.test(message)) return "A command isn't defined: a typo, or a package that provides it isn't loaded.";
  if (/Missing \$ inserted/.test(message)) return "A math-only character (_ ^ or a math command) is used in text. Escape it as \\_ or wrap it in $...$.";
  if (/Misplaced alignment tab character &/.test(message)) return "A bare & in text. Write \\& for an ampersand.";
  if (/Extra alignment tab|Extra \}|Missing \} inserted|Too many \}'s/.test(message)) return "Unbalanced braces near this line.";
  if (/-shell-escape|shell escape|--enable-write18|write18/i.test(message)) {
    return "This package runs external programs (minted, svg, gnuplottex…). Turn on Settings → Compiler → Trusted project to allow it for this resume.";
  }
  if (/not loadable: Metric \(TFM\) file or installed font not found|cannot be found/.test(message) && /Font|font/.test(message)) {
    return "That font isn't installed. Use a font that comes with TeX Live or with macOS (Font Book), or add the font files to the project and load them by file name, e.g. \\setmainfont{Lato}[Path=fonts/, Extension=.ttf, UprightFont=*-Regular].";
  }
  if (/Paragraph ended before .* was complete|File ended while scanning use of/.test(message))
    return "A command's argument is never closed: look for a missing } before this point.";
  if (/Unknown graphics extension|Cannot determine size of graphic/.test(message))
    return "pdfLaTeX can include PDF, PNG and JPG images. Convert other formats (e.g. WebP, HEIC, SVG) first.";
  if (/LaTeX Error: Environment .* undefined/.test(message)) return "The environment isn't defined: a typo, or the package that provides it isn't loaded.";
  if (/LaTeX Error: Can be used only in preamble/.test(message)) return "Move this command above \\begin{document}.";
  if (/LaTeX Error: Missing \\begin\{document\}/.test(message))
    return "Text or a command that prints something appears before \\begin{document}, or the preamble has an error above.";
  if (/requires either XeTeX or LuaTeX/.test(message))
    return "This document uses fontspec, so it must be built with XeLaTeX or LuaLaTeX. Choose one in Settings → Compiler, or put % !TEX program = xelatex on the first line.";
  if (/Emergency stop/.test(message)) return "TeX stopped early; the first error above is the real cause.";
  return undefined;
}

export function parseLog(log: string, opts: ParseOptions): Diagnostic[] {
  const lines = log.replace(/\r\n?/g, "\n").split("\n");
  const out: Diagnostic[] = [];
  const files = new FileStack();
  const seen = new Set<string>();

  const push = (d: Diagnostic) => {
    const key = `${d.severity}|${d.file}|${d.line}|${d.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1) file:line: error (from -file-line-error)
    const fle = FILE_LINE_ERROR.exec(line);
    if (fle && !line.startsWith("(")) {
      const [, rawFile, lineNo, msg] = fle;
      const { detail, consumed, contextLine } = collectErrorContext(lines, i + 1);
      i += consumed;
      if (/^\s*==> Fatal error occurred/.test(msg)) continue; // always follows a real error
      const message = msg.replace(/^LaTeX Error: /, "").replace(/\.$/, "");
      const file = relFile(rawFile, opts.rootDir, opts.cwd);
      push({
        severity: "error",
        kind: /^Package \S+ Error/.test(msg) ? "package" : "latex",
        file,
        // The line belongs to the file it was raised in; for a TeX Live file it means nothing to you.
        line: file ? Number(lineNo) || contextLine : null,
        origin: file ? undefined : basename(rawFile),
        message,
        detail: joinDetail(detail, errorHint(msg)),
      });
      continue;
    }

    // 2) "! message" errors (no file:line prefix: fatal errors, errors inside some packages)
    if (line.startsWith("! ")) {
      const msg = line.slice(2).trim();
      const { detail, consumed, contextLine } = collectErrorContext(lines, i + 1);
      i += consumed;
      if (/^==> Fatal error occurred/.test(msg)) continue; // always follows a real error
      const cur = files.current();
      const file = relFile(cur, opts.rootDir, opts.cwd);
      push({
        severity: "error",
        kind: "latex",
        file,
        line: file ? contextLine : null,
        origin: file || !cur ? undefined : basename(cur.replace(/^"|"$/g, "")),
        message: msg.replace(/^LaTeX Error: /, "").replace(/\.$/, ""),
        detail: joinDetail(detail, errorHint(msg)),
      });
      continue;
    }

    // 3) LaTeX / package / font warnings (may continue over following lines)
    const warn = /^(LaTeX|LaTeX Font|Package (\S+)|Class (\S+)) Warning: (.*)$/.exec(line);
    if (warn) {
      const pkg = warn[2] ?? warn[3];
      let text = warn[4];
      // Continuation lines are indented to line up under the message, or start with "(pkgname)".
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "" && (/^\s{2,}/.test(lines[j]) || (pkg && lines[j].startsWith(`(${pkg})`)))) {
        text += " " + lines[j].replace(pkg ? `(${pkg})` : "", "").trim();
        j++;
      }
      i = j - 1;
      text = text.replace(/\s+/g, " ").trim();
      const lineMatch = INPUT_LINE.exec(text);
      // "Label(s) may have changed" and "rerun" notices are handled by latexmk's reruns.
      if (/Label\(s\) may have changed|Rerun to get/.test(text)) continue;
      const kind: Diagnostic["kind"] = /Reference .* undefined|There were undefined references/.test(text)
        ? "reference"
        : /Citation .* undefined|There were undefined citations/.test(text)
          ? "citation"
          : warn[1] === "LaTeX Font"
            ? "font"
            : pkg
              ? "package"
              : "latex";
      push({
        severity: kind === "font" && /Some font shapes were not available|Size substitutions/.test(text) ? "info" : "warning",
        kind,
        file: relFile(files.current(), opts.rootDir, opts.cwd),
        line: lineMatch ? Number(lineMatch[1]) : null,
        message: (pkg ? `${pkg}: ` : "") + text.replace(/\s*on input line \d+\.?/, "").replace(/\.$/, ""),
      });
      files.feed(line);
      continue;
    }

    // 4) Over/underfull boxes: an overfull box is text running into the margin, visible on the page.
    const box = BOX.exec(line);
    if (box) {
      const [, which, dir, amount, from, , detected] = box;
      const ln = Number(from ?? detected) || null;
      const pt = parseFloat(amount);
      const over = which === "Overfull";
      if (over && pt < 0.5) continue; // sub-half-point overflow is invisible
      push({
        severity: over ? "warning" : "info",
        kind: "box",
        file: relFile(files.current(), opts.rootDir, opts.cwd),
        line: ln,
        message: over
          ? `Text overflows the ${dir === "h" ? "right margin" : "page"} by ${pt.toFixed(1)}pt`
          : `Underfull \\${dir}box (${amount}): loose spacing`,
        detail: over ? "Shorten the line, or let it break (long URLs and unbreakable words are the usual cause)." : undefined,
      });
      files.feed(line);
      continue;
    }

    // 5) Characters that silently vanish from the output (fonts without that glyph).
    const missing = /^Missing character: There is no (.+?) in font (.+?)!/.exec(line);
    if (missing) {
      push({
        severity: "warning",
        kind: "font",
        file: null,
        line: null,
        message: `The character ${missing[1]} is missing from font ${missing[2]} and won't appear in the PDF`,
      });
      continue;
    }

    files.feed(line);
  }

  // Errors first, then warnings, then info; inside each, by file and line.
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.file ?? "~").localeCompare(b.file ?? "~") || (a.line ?? 0) - (b.line ?? 0));
}

/**
 * The lines after an error: TeX prints the help text, then "l.<n> <text before the error>" and the
 * text after it on the next line. Returns the excerpt, how many lines were consumed and the line number.
 */
function collectErrorContext(lines: string[], start: number): { detail: string; consumed: number; contextLine: number | null } {
  const buf: string[] = [];
  let contextLine: number | null = null;
  let j = start;
  for (; j < lines.length && j < start + 12; j++) {
    const l = lines[j];
    const ctx = /^l\.(\d+) (.*)$/.exec(l);
    if (ctx) {
      contextLine = Number(ctx[1]);
      const after = (lines[j + 1] ?? "").trim();
      buf.push(`${ctx[2].trimEnd()}${after ? ` ⟨here⟩ ${after}` : " ⟨here⟩"}`);
      j += after ? 2 : 1;
      break;
    }
    if (FILE_LINE_ERROR.test(l) || l.startsWith("! ")) break; // next error
    if (l.trim() === "" && buf.length) continue;
    if (/^(Type|See the|You're in trouble|or enter new|I'm going to|\(Press Enter|Try typing)/.test(l.trim())) continue;
    if (l.trim()) buf.push(l.trim());
  }
  return { detail: buf.join("\n").trim(), consumed: j - start, contextLine };
}

function joinDetail(detail: string, hint: string | undefined): string | undefined {
  const parts = [detail, hint].filter(Boolean);
  return parts.length ? parts.join("\n\n") : undefined;
}

/**
 * An error inside a package (XCharter.sty needs scalefnt.sty, which is missing) is reported at the
 * package's own file and line, which you can't open. Point it at the \usepackage (or \documentclass)
 * line in your file that loaded that package instead.
 */
export function attributeToUsepackage(diags: Diagnostic[], sources: Record<string, string>): Diagnostic[] {
  return diags.map((d) => {
    if (d.file || !d.origin) return d;
    const pkg = d.origin.replace(/\.(sty|cls)$/, "");
    for (const [file, src] of Object.entries(sources)) {
      const lines = src.split("\n");
      const i = lines.findIndex((l) => {
        const code = l.replace(/(^|[^\\])%.*$/, "$1");
        return new RegExp(
          `\\\\(usepackage|RequirePackage|documentclass)\\s*(\\[[^\\]]*\\])?\\s*\\{[^}]*\\b${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^}]*\\}`,
        ).test(code);
      });
      if (i >= 0) return { ...d, file, line: i + 1, detail: [`Raised inside ${d.origin}, loaded here.`, d.detail].filter(Boolean).join("\n\n") };
    }
    return { ...d, detail: [`Raised inside ${d.origin}.`, d.detail].filter(Boolean).join("\n\n") };
  });
}

/**
 * BibTeX and biber problems from the .blg (Overleaf lists these too): bad entries in a .bib file with
 * their line, and citation keys with no entry.
 */
export function parseBibLog(blg: string, opts: ParseOptions): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  const push = (d: Diagnostic) => {
    const k = `${d.severity}|${d.file}|${d.line}|${d.message}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(d);
    }
  };
  const bibFile = (raw: string) => {
    // biber reports "<tmpdir>/refs.bib_12345.utf8" for its UTF-8 copy of refs.bib.
    const name = raw.replace(/_\d+\.utf8$/, "").trim();
    return relFile(name, opts.rootDir, opts.cwd) ?? relFile(basename(name), opts.rootDir, opts.cwd);
  };
  for (const line of blg.split(/\r?\n/)) {
    // biber: "[123] Utils.pm:411> WARN - I didn't find a database entry for 'knuth'"
    const biber = /^\[\d+\]\s+\S+>\s+(WARN|ERROR)\s+-\s+(.*)$/.exec(line);
    if (biber) {
      const [, level, msg] = biber;
      const at = /(?:BibTeX subsystem|in file):?\s*'?([^',]+?\.bib(?:_\d+\.utf8)?)'?,\s*line\s+(\d+)/.exec(msg);
      const key = /database entry for '([^']+)'/.exec(msg);
      push({
        severity: level === "ERROR" ? "error" : "warning",
        kind: "citation",
        file: at ? bibFile(at[1]) : null,
        line: at ? Number(at[2]) : null,
        message: `biber: ${key ? `No bibliography entry for “${key[1]}”` : msg.replace(/\s+/g, " ").trim()}`,
        detail: key ? "Add the entry to your .bib file, or fix the key in \\cite." : undefined,
      });
      continue;
    }
    // BibTeX: 'Warning--I didn't find a database entry for "knuth"'
    const missing = /^Warning--I didn't find a database entry for "([^"]+)"/.exec(line);
    if (missing) {
      push({
        severity: "warning",
        kind: "citation",
        file: null,
        line: null,
        message: `BibTeX: No bibliography entry for “${missing[1]}”`,
        detail: "Add the entry to your .bib file, or fix the key in \\cite.",
      });
      continue;
    }
    // BibTeX: "I was expecting a `,' or a `}'---line 5 of file refs.bib"
    const syntax = /^(.*?)---line (\d+) of file (.+)$/.exec(line);
    if (syntax) {
      push({ severity: "error", kind: "citation", file: bibFile(syntax[3]), line: Number(syntax[2]), message: `BibTeX: ${syntax[1].trim()}` });
      continue;
    }
    const bibWarn = /^Warning--(.*)$/.exec(line);
    if (bibWarn) push({ severity: "warning", kind: "citation", file: null, line: null, message: `BibTeX: ${bibWarn[1].trim()}` });
  }
  return out;
}
