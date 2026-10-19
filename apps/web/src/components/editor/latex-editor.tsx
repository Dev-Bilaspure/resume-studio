"use client";

import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from "@codemirror/language";
import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { emacs } from "@replit/codemirror-emacs";
import { vim } from "@replit/codemirror-vim";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { EditorSettings } from "@/lib/editor-settings";
import type { Diagnostic, ProjectSymbols } from "@/lib/types";
import { latexSupport } from "./latex-language";
import { createFindPanel } from "./find-panel";
import { editorTheme } from "./theme";

export interface LatexEditorHandle {
  /** Replaces the document with what's on disk (external edit, restore), keeping the cursor nearby. */
  replaceContent(path: string, content: string): void;
  /** Moves the cursor to a line (1-based) and briefly highlights it. */
  goto(line: number, column?: number): void;
  getContent(): string;
  focus(): void;
  /** Drops the cached editor state (undo history) of a file that was deleted or renamed. */
  forget(path: string): void;
}

interface Props {
  path: string;
  /** Content to start from when `path` is opened for the first time. */
  initialContent: string;
  diagnostics: Diagnostic[];
  readOnly?: boolean;
  onChange(path: string, content: string): void;
  onSave(): void;
  onCompile(): void;
  onForwardSync(line: number, column: number): void;
  onCursor?(line: number, column: number): void;
  settings: EditorSettings;
  /** Labels, citation keys, files and commands from the whole project, for completion. */
  symbols: ProjectSymbols | null;
}

// Settings that change live, without recreating the editor.
const keymapMode = new Compartment();
const wrapping = new Compartment();
const fontSize = new Compartment();
const spelling = new Compartment();
const pairing = new Compartment();

function settingsExtensions(s: EditorSettings) {
  return {
    keymap: s.keymap === "vim" ? vim() : s.keymap === "emacs" ? emacs() : [],
    wrap: s.lineWrapping ? EditorView.lineWrapping : [],
    font: EditorView.theme({ "&": { fontSize: `${s.fontSize}px` } }),
    spell: EditorView.contentAttributes.of({ spellcheck: s.spellcheck ? "true" : "false", autocorrect: "off", autocapitalize: "off" }),
    pair: s.autoClose ? closeBrackets() : [],
  };
}

function reconfigureAll(s: EditorSettings) {
  const x = settingsExtensions(s);
  return [
    keymapMode.reconfigure(x.keymap),
    wrapping.reconfigure(x.wrap),
    fontSize.reconfigure(x.font),
    spelling.reconfigure(x.spell),
    pairing.reconfigure(x.pair),
  ];
}

// A short-lived highlight on the line you jumped to (from a problem, an ATS check or the PDF).
const flashEffect = StateEffect.define<number | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        deco = e.value === null ? Decoration.none : Decoration.set([Decoration.line({ class: "cm-flash-line" }).range(e.value)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function toCm(state: EditorState, diags: Diagnostic[]): CmDiagnostic[] {
  const out: CmDiagnostic[] = [];
  for (const d of diags) {
    if (!d.line || d.line < 1 || d.line > state.doc.lines) continue;
    const line = state.doc.line(d.line);
    // Point at the text of the line, not its indentation.
    const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;
    out.push({
      from: Math.min(line.from + indent, line.to),
      to: line.to,
      severity: d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info",
      message: d.message + (d.detail ? `\n\n${d.detail}` : ""),
      source: d.kind === "box" ? "layout" : "LaTeX",
    });
  }
  return out;
}

export const LatexEditor = forwardRef<LatexEditorHandle, Props>(function LatexEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const current = useRef<string>(props.path);
  const cb = useRef(props);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    cb.current = props;
  });

  const extensions = (readOnly: boolean): Extension[] => {
    const x = settingsExtensions(cb.current.settings);
    return [
      // Vim/Emacs bindings must come before the other keymaps.
      keymapMode.of(x.keymap),
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter({ openText: "▾", closedText: "▸" }),
      lintGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      indentUnit.of("  "),
      bracketMatching(),
      pairing.of(x.pair),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true, createPanel: createFindPanel }),
      wrapping.of(x.wrap),
      fontSize.of(x.font),
      spelling.of(x.spell),
      EditorState.readOnly.of(readOnly),
      latexSupport({
        getSymbols: () => cb.current.symbols,
        autocomplete: () => cb.current.settings.autocomplete,
        autoClose: () => cb.current.settings.autoClose,
      }),
      flashField,
      editorTheme,
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave(), true) },
        { key: "Mod-Enter", preventDefault: true, run: () => (cb.current.onCompile(), true) },
        {
          key: "Mod-j",
          preventDefault: true,
          run: (v) => {
            const head = v.state.selection.main.head;
            const line = v.state.doc.lineAt(head);
            cb.current.onForwardSync(line.number, head - line.from);
            return true;
          },
        },
        { key: "Mod-/", run: toggleComment },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) cb.current.onChange(current.current, u.state.doc.toString());
        if (u.selectionSet || u.docChanged) {
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head);
          cb.current.onCursor?.(line.number, head - line.from + 1);
        }
      }),
    ];
  };

  const makeState = (content: string) => EditorState.create({ doc: content, extensions: extensions(!!cb.current.readOnly) });

  // Create the view once.
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({ state: makeState(props.initialContent), parent: host.current });
    view.current = v;
    current.current = props.path;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switching files: keep each file's state (undo history, cursor, scroll) for when you come back.
  useEffect(() => {
    const v = view.current;
    if (!v || current.current === props.path) return;
    states.current.set(current.current, v.state);
    current.current = props.path;
    v.setState(states.current.get(props.path) ?? makeState(props.initialContent));
    // A cached state may predate a settings change.
    v.dispatch({ effects: reconfigureAll(props.settings) });
    v.dispatch(setDiagnostics(v.state, toCm(v.state, props.diagnostics)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path]);

  // Settings changed: apply them to the open editor.
  useEffect(() => {
    view.current?.dispatch({ effects: reconfigureAll(props.settings) });
  }, [props.settings]);

  // Problems from the latest build, for this file.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch(setDiagnostics(v.state, toCm(v.state, props.diagnostics)));
  }, [props.diagnostics]);

  useImperativeHandle(ref, () => ({
    replaceContent(path, content) {
      const v = view.current;
      if (!v) return;
      if (path !== current.current) {
        states.current.delete(path); // reopens fresh from disk next time
        return;
      }
      const old = v.state.doc.toString();
      if (old === content) return;
      // Keep the cursor on the same line number (content above it may have changed length).
      const head = v.state.selection.main.head;
      const lineNo = v.state.doc.lineAt(head).number;
      v.dispatch({ changes: { from: 0, to: old.length, insert: content }, userEvent: "external" });
      const line = v.state.doc.line(Math.min(lineNo, v.state.doc.lines));
      v.dispatch({ selection: EditorSelection.cursor(line.from) });
    },
    goto(lineNo, column = 0) {
      const v = view.current;
      if (!v) return;
      const line = v.state.doc.line(Math.max(1, Math.min(lineNo, v.state.doc.lines)));
      const pos = Math.min(line.from + Math.max(0, column), line.to);
      v.dispatch({
        selection: EditorSelection.cursor(pos),
        effects: [EditorView.scrollIntoView(pos, { y: "center" }), flashEffect.of(line.from)],
      });
      v.focus();
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => view.current?.dispatch({ effects: flashEffect.of(null) }), 1400);
    },
    getContent: () => view.current?.state.doc.toString() ?? "",
    focus: () => view.current?.focus(),
    forget: (path) => {
      states.current.delete(path);
    },
  }));

  return <div ref={host} className="h-full min-h-0 overflow-hidden [&_.cm-editor]:h-full" />;
});
