"use client";

import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { HighlightStyle, StreamLanguage, foldService, syntaxHighlighting } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { EditorSelection, EditorState, type Extension, type Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { ProjectSymbols } from "@/lib/types";
import { COMMANDS, ENVIRONMENTS, PACKAGES } from "./latex-data";

/** LaTeX syntax (CodeMirror's stex mode), with % comments for toggle-comment. */
export const latexLanguage = StreamLanguage.define(stex);

// Brace/bracket pairing only: auto-closing quotes would fight LaTeX's `` '' quotes and apostrophes.
const languageData = EditorState.languageData.of(() => [{ closeBrackets: { brackets: ["{", "[", "("] }, commentTokens: { line: "%" } }]);

// Colours tuned to the app palette (oklch near-black, blue accent).
// stex emits: tag = \command, keyword = math delimiters, atom = digits in text (your metrics stand out),
// variableName.special / number = inside math, bracket = {}[], error = an unmatched closing brace.
const highlight = HighlightStyle.define([
  { tag: t.tagName, color: "oklch(0.74 0.14 255)" },
  { tag: t.keyword, color: "oklch(0.75 0.14 320)" },
  { tag: [t.atom, t.number], color: "oklch(0.83 0.12 80)" },
  { tag: t.special(t.variableName), color: "oklch(0.8 0.11 150)" },
  { tag: t.bracket, color: "oklch(0.62 0.02 286)" },
  { tag: t.comment, color: "oklch(0.55 0.012 286)", fontStyle: "italic" },
  { tag: t.invalid, color: "oklch(0.7 0.19 22)", textDecoration: "underline wavy" },
]);

// ---- Completion ---------------------------------------------------------------------------------------------

const REF_CMDS = "ref|eqref|pageref|autoref|nameref|cref|Cref|cpageref|vref|Vref|labelcref";
const CITE_CMDS =
  "cite|citep|citet|citealp|citealt|citeauthor|citeyear|nocite|parencite|textcite|autocite|footcite|fullcite|smartcite|supercite|Cite|Parencite|Textcite|Autocite";
const FILE_CMDS: Record<string, { ext: RegExp; strip?: RegExp }> = {
  input: { ext: /\.(tex|sty|cls)$/, strip: /\.tex$/ },
  include: { ext: /\.tex$/, strip: /\.tex$/ },
  subfile: { ext: /\.tex$/ },
  includeonly: { ext: /\.tex$/, strip: /\.tex$/ },
  includegraphics: { ext: /\.(png|jpe?g|pdf|eps|svg|gif)$/i },
  includesvg: { ext: /\.svg$/i, strip: /\.svg$/i },
  addbibresource: { ext: /\.bib$/ },
  bibliography: { ext: /\.bib$/, strip: /\.bib$/ },
  lstinputlisting: { ext: /./ },
  inputminted: { ext: /./ },
  verbatiminput: { ext: /./ },
};

/** \begin{env} as typed, with the matching \end{env} and the cursor on the line between. */
function beginSnippet(env: string): Completion["apply"] {
  return (view, _c, from, to) => {
    const line = view.state.doc.lineAt(from);
    const indent = /^\s*/.exec(line.text)?.[0] ?? "";
    const body = env === "itemize" || env === "enumerate" ? "\\item " : "";
    const insert = `${env}}\n${indent}  ${body}\n${indent}\\end{${env}}`;
    // Replace through an auto-inserted "}" if closeBrackets added one.
    const end = view.state.sliceDoc(to, to + 1) === "}" ? to + 1 : to;
    view.dispatch({
      changes: { from, to: end, insert },
      selection: EditorSelection.cursor(from + env.length + 2 + indent.length + 2 + body.length),
      userEvent: "input.complete",
    });
  };
}

export function latexCompletions(getSymbols: () => ProjectSymbols | null, enabled: () => boolean = () => true) {
  return (ctx: CompletionContext): CompletionResult | null => {
    if (!ctx.explicit && !enabled()) return null; // Ctrl+Space still works with autocomplete off
    const sym = getSymbols();
    const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 300), ctx.pos);

    // \begin{| or \end{| → environments (user-defined first)
    const env = /\\(begin|end)\{([A-Za-z*@]*)$/.exec(before);
    if (env) {
      const names = [...new Set([...(sym?.environments ?? []), ...ENVIRONMENTS])];
      return {
        from: ctx.pos - env[2].length,
        options: names.map((name) => ({
          label: name,
          type: "type",
          apply: env[1] === "begin" ? beginSnippet(name) : undefined,
          boost: sym?.environments.includes(name) ? 2 : 0,
        })),
        validFor: /^[A-Za-z*@]*$/,
      };
    }

    // \ref{|, \cref{a,| → labels
    const ref = new RegExp(`\\\\(?:${REF_CMDS})\\*?\\{([^}]*,)?([^},]*)$`).exec(before);
    if (ref) {
      return {
        from: ctx.pos - ref[2].length,
        options: (sym?.labels ?? []).map((l) => ({ label: l.name, type: "variable", detail: `${l.file}:${l.line}` })),
        validFor: /^[^},]*$/,
      };
    }

    // \cite{|, \parencite[p. 3]{a,| → bibliography keys
    const cite = new RegExp(`\\\\(?:${CITE_CMDS})\\*?(?:\\[[^\\]]*\\]){0,2}\\{([^}]*,)?\\s*([^},\\s]*)$`).exec(before);
    if (cite) {
      return {
        from: ctx.pos - cite[2].length,
        options: (sym?.citations ?? []).map((c) => ({
          label: c.key,
          type: "text",
          detail: c.title ? c.title.slice(0, 60) : c.type,
          info: [c.author, c.title, c.file].filter(Boolean).join("\n"),
        })),
        validFor: /^[^},\s]*$/,
      };
    }

    // \input{|, \includegraphics[width=…]{| → project files
    const fileCmd =
      /\\(input|include|subfile|includeonly|includegraphics|includesvg|addbibresource|bibliography|lstinputlisting|inputminted|verbatiminput)\*?(?:\[[^\]]*\])?(?:\{[^}]*\})?\{([^}]*)$/.exec(
        before,
      );
    if (fileCmd && FILE_CMDS[fileCmd[1]]) {
      const rule = FILE_CMDS[fileCmd[1]];
      const partial = fileCmd[2].split(",").pop() ?? "";
      const files = (sym?.files ?? []).filter((f) => rule.ext.test(f) && !/-eps-converted-to\.pdf$/.test(f));
      return {
        from: ctx.pos - partial.length,
        options: files.map((f) => ({ label: rule.strip ? f.replace(rule.strip, "") : f, type: "file" })),
        validFor: /^[^},]*$/,
      };
    }

    // \usepackage{|, \usepackage[opt]{a,| → packages
    const pkg = /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]*,)?\s*([A-Za-z0-9-]*)$/.exec(before);
    if (pkg) {
      return {
        from: ctx.pos - pkg[2].length,
        options: [...new Set([...PACKAGES.map((p) => p[0]), ...(sym?.packages ?? [])])].map((name) => ({
          label: name,
          type: "namespace",
          detail: PACKAGES.find((p) => p[0] === name)?.[1],
        })),
        validFor: /^[A-Za-z0-9-]*$/,
      };
    }

    // \commands
    const cmd = ctx.matchBefore(/\\[A-Za-z@]*/);
    if (!cmd || (cmd.from === cmd.to && !ctx.explicit)) return null;
    const user: Completion[] = (sym?.commands ?? []).map((c) => ({
      label: `\\${c.name}`,
      apply: `\\${c.name}${"{}".repeat(c.args)}`,
      type: "function",
      detail: c.args ? `${c.args} argument${c.args > 1 ? "s" : ""}` : "your command",
      boost: 2,
    }));
    const builtin: Completion[] = COMMANDS.map(([snippet, detail]) => {
      const name = snippet.replace(/[[{ ].*$/, "");
      return { label: `\\${name}`, apply: `\\${snippet}`, detail, type: "keyword" };
    });
    const seen = new Set<string>();
    const options = [...user, ...builtin].filter((o) => (seen.has(o.label) ? false : (seen.add(o.label), true)));
    return { from: cmd.from, options, validFor: /^\\[A-Za-z@]*$/ };
  };
}

/** Puts the cursor inside the first {} or [] of an applied completion like \href{|}{}. */
const cursorIntoBraces = EditorView.updateListener.of((u) => {
  for (const tr of u.transactions) {
    if (!tr.isUserEvent("input.complete")) continue;
    const head = u.state.selection.main.head;
    const line = u.state.doc.lineAt(head);
    const before = line.text.slice(0, head - line.from);
    const m = /\\[A-Za-z@]+((?:\[\]|\{\})+)$/.exec(before);
    if (!m) continue;
    const firstOpen = before.length - m[1].length + 1;
    u.view.dispatch({ selection: { anchor: line.from + firstOpen } });
  }
});

// ---- \begin{…} auto-close ---------------------------------------------------------------------------------

function countEnv(doc: string, env: string) {
  const esc = env.replace(/[*]/g, "\\*");
  const strip = doc.replace(/(^|[^\\])%.*$/gm, "$1");
  return {
    begins: (strip.match(new RegExp(`\\\\begin\\s*\\{${esc}\\}`, "g")) ?? []).length,
    ends: (strip.match(new RegExp(`\\\\end\\s*\\{${esc}\\}`, "g")) ?? []).length,
  };
}

/** Enter right after \begin{env}(args) adds the matching \end{env} if the document lacks one. */
const closeEnvironmentOnEnter = (enabled: () => boolean) =>
  keymap.of([
    {
      key: "Enter",
      run(view) {
        if (!enabled()) return false;
        const sel = view.state.selection.main;
        if (!sel.empty) return false;
        const line = view.state.doc.lineAt(sel.head);
        const before = line.text.slice(0, sel.head - line.from);
        const after = line.text.slice(sel.head - line.from);
        const m = /\\begin\{([A-Za-z*@]+)\}(?:\[[^\]]*\]|\{[^}]*\})*\s*$/.exec(before);
        if (!m || after.trim()) return false;
        const env = m[1];
        if (env === "document") return false;
        const { begins, ends } = countEnv(view.state.doc.toString(), env);
        if (ends >= begins) return false;
        const indent = /^\s*/.exec(line.text)?.[0] ?? "";
        const body = env === "itemize" || env === "enumerate" ? "\\item " : "";
        const insert = `\n${indent}  ${body}\n${indent}\\end{${env}}`;
        view.dispatch({
          changes: { from: sel.head, insert },
          selection: EditorSelection.cursor(sel.head + 1 + indent.length + 2 + body.length),
          userEvent: "input",
        });
        return true;
      },
    },
  ]);

// ---- Folding ------------------------------------------------------------------------------------------------

const SECTION_LEVEL: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };
const SECTION_RE = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{/;

/** Folds \begin{x}…\end{x} and a section up to the next heading of the same or a higher level. */
function latexFold(doc: Text, lineFrom: number, lineTo: number): { from: number; to: number } | null {
  const line = doc.lineAt(lineFrom);
  const text = line.text.replace(/(^|[^\\])%.*$/, "$1");
  const begin = /\\begin\{([^}]+)\}/.exec(text);
  if (begin && !new RegExp(`\\\\end\\{${begin[1].replace(/\*/g, "\\*")}\\}`).test(text)) {
    let depth = 0;
    for (let n = line.number + 1; n <= doc.lines; n++) {
      const l = doc.line(n).text.replace(/(^|[^\\])%.*$/, "$1");
      if (l.includes(`\\begin{${begin[1]}}`)) depth++;
      if (l.includes(`\\end{${begin[1]}}`)) {
        // Fold the lines between \begin and \end, keeping both visible.
        if (depth === 0) return n > line.number + 1 ? { from: lineTo, to: doc.line(n - 1).to } : null;
        depth--;
      }
    }
    return null;
  }
  const sec = SECTION_RE.exec(text);
  if (sec) {
    const level = SECTION_LEVEL[sec[1]];
    let end = doc.lines;
    for (let n = line.number + 1; n <= doc.lines; n++) {
      const l = doc.line(n).text;
      const s = SECTION_RE.exec(l);
      if ((s && SECTION_LEVEL[s[1]] <= level) || /^\s*\\end\{document\}/.test(l)) {
        end = n - 1;
        break;
      }
    }
    // Don't swallow trailing blank lines.
    while (end > line.number && !doc.line(end).text.trim()) end--;
    return end > line.number ? { from: lineTo, to: doc.line(end).to } : null;
  }
  return null;
}

// ---- Outline ------------------------------------------------------------------------------------------------

export interface OutlineItem {
  level: number;
  title: string;
  line: number;
}

/** Headings in a file, for the outline panel (Overleaf's "File outline"). */
export function parseOutline(src: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  const lines = src.split("\n");
  lines.forEach((raw, i) => {
    const text = raw.replace(/(^|[^\\])%.*$/, "$1");
    const m = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/.exec(text);
    if (!m) return;
    // The title: the balanced {…} after the command.
    let depth = 1;
    let j = m.index + m[0].length;
    let title = "";
    for (; j < text.length && depth > 0; j++) {
      const c = text[j];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      if (depth > 0) title += c;
    }
    title = title
      .replace(/\\[A-Za-z]+\*?(\[[^\]]*\])?/g, "")
      .replace(/[{}]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    out.push({ level: SECTION_LEVEL[m[1]], title: title || m[1], line: i + 1 });
  });
  return out;
}

export function latexSupport(opts: { getSymbols: () => ProjectSymbols | null; autocomplete?: () => boolean; autoClose?: () => boolean }): Extension {
  return [
    latexLanguage,
    languageData,
    syntaxHighlighting(highlight),
    autocompletion({ override: [latexCompletions(opts.getSymbols, opts.autocomplete)], icons: false, activateOnTyping: true, maxRenderedOptions: 80 }),
    cursorIntoBraces,
    closeEnvironmentOnEnter(opts.autoClose ?? (() => true)),
    foldService.of((state, from, to) => latexFold(state.doc, from, to)),
  ];
}
