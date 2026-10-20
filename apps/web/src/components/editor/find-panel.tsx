"use client";

import { SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, setSearchQuery } from "@codemirror/search";
import { EditorSelection, type EditorState } from "@codemirror/state";
import { EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import { ArrowDown, ArrowUp, CaseSensitive, ChevronRight, Regex, Replace, ReplaceAll, WholeWord, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ALT_KEY, FindToggle, MOD_KEY } from "@/components/find-controls";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// The editor's find bar, in place of CodeMirror's own panel: searches as you type (every match highlighted,
// the nearest one selected, "3 of 12"), icon buttons as in VS Code, and ⌘F toggles it. It drives
// CodeMirror's search state and commands, so highlighting, ⌘G and replace behave as before.

const MAX_COUNTED = 9999;

/** createPanel for CodeMirror's search(): `search({ top: true, createPanel: createFindPanel })`. */
export function createFindPanel(view: EditorView): Panel {
  return new FindPanel(view);
}

class FindPanel implements Panel {
  dom: HTMLElement;
  top = true;
  private root: Root | null = null;
  private listeners = new Set<() => void>();
  /** Bumped on every change the widget shows (document, selection, query). */
  version = 0;

  readonly view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
    this.dom = document.createElement("div");
    this.dom.className = "cm-find-panel";
  }

  mount() {
    this.root = createRoot(this.dom);
    this.root.render(
      <TooltipProvider delay={400}>
        <FindWidget panel={this} />
      </TooltipProvider>,
    );
  }

  update(u: ViewUpdate) {
    if (u.docChanged || u.selectionSet || u.transactions.some((t) => t.effects.some((e) => e.is(setSearchQuery)))) {
      this.version++;
      this.listeners.forEach((f) => f());
    }
  }

  destroy() {
    const root = this.root;
    this.root = null;
    // Unmount after CodeMirror's update finishes (React can't unmount synchronously during another render).
    queueMicrotask(() => root?.unmount());
  }

  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  };
}

/** How many matches, and which one the selection is (0: none selected). */
function countMatches(state: EditorState, query: SearchQuery): { total: number; current: number; capped: boolean } {
  if (!query.search || !query.valid) return { total: 0, current: 0, capped: false };
  const sel = state.selection.main;
  let total = 0;
  let current = 0;
  const cursor = query.getCursor(state);
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    total++;
    if (r.value.from === sel.from && r.value.to === sel.to) current = total;
    if (total >= MAX_COUNTED) return { total, current, capped: true };
  }
  return { total, current, capped: false };
}

/** Selects the first match at or after the selection's start (wrapping), as you type. */
function selectNearest(view: EditorView, query: SearchQuery) {
  if (!query.search || !query.valid) return;
  const from = view.state.selection.main.from;
  const after = query.getCursor(view.state, from).next();
  const m = after.done ? query.getCursor(view.state, 0, from).next() : after;
  if (m.done) return;
  view.dispatch({
    selection: EditorSelection.single(m.value.from, m.value.to),
    effects: EditorView.scrollIntoView(m.value.from, { y: "center" }),
    userEvent: "select.search",
  });
}

function FindWidget({ panel }: { panel: FindPanel }) {
  const view = panel.view;
  useSyncExternalStore(panel.subscribe, () => panel.version);
  const query = getSearchQuery(view.state);
  const readOnly = view.state.readOnly;
  const [showReplace, setShowReplace] = useState(!!query.replace && !readOnly);
  const findInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const { total, current, capped } = countMatches(view.state, query);

  // Opened: focus the field with its text selected, ready to type over.
  useEffect(() => {
    findInput.current?.focus();
    findInput.current?.select();
  }, []);

  const apply = (patch: Partial<{ search: string; replace: string; caseSensitive: boolean; wholeWord: boolean; regexp: boolean }>, jump: boolean) => {
    const q = getSearchQuery(view.state);
    const next = new SearchQuery({
      search: patch.search ?? q.search,
      replace: patch.replace ?? q.replace,
      caseSensitive: patch.caseSensitive ?? q.caseSensitive,
      wholeWord: patch.wholeWord ?? q.wholeWord,
      regexp: patch.regexp ?? q.regexp,
    });
    if (next.eq(q)) return;
    view.dispatch({ effects: setSearchQuery.of(next) });
    if (jump) selectNearest(view, next);
  };

  const close = () => {
    closeSearchPanel(view);
    view.focus();
  };

  // Shared by both fields: ⌘F closes (it opened the bar), Esc closes, ⌥C/⌥W/⌥R toggle the options.
  const commonKeys = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if ((mod && e.key.toLowerCase() === "f" && !e.shiftKey && !e.altKey) || e.key === "Escape") {
      e.preventDefault();
      close();
      return true;
    }
    if (e.altKey && !mod) {
      const code = e.code;
      if (code === "KeyC") apply({ caseSensitive: !query.caseSensitive }, true);
      else if (code === "KeyW") apply({ wholeWord: !query.wholeWord }, true);
      else if (code === "KeyR") apply({ regexp: !query.regexp }, true);
      else return false;
      e.preventDefault();
      return true;
    }
    return false;
  };

  const status = !query.search ? "" : !query.valid ? "Invalid pattern" : total === 0 ? "No results" : `${current || "?"} of ${total}${capped ? "+" : ""}`;

  return (
    <div className="flex items-start gap-1 px-2 py-1.5 font-sans text-xs" role="search" aria-label="Find in file">
      {!readOnly && (
        <IconButton
          label={showReplace ? "Hide replace" : "Show replace"}
          onClick={() => {
            setShowReplace((s) => !s);
            setTimeout(() => (showReplace ? findInput : replaceInput).current?.focus(), 0);
          }}
          className="mt-0.5"
        >
          <ChevronRight className={cn("transition-transform", showReplace && "rotate-90")} />
        </IconButton>
      )}
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex items-center gap-1">
          <div
            className={cn(
              "flex h-7 min-w-0 flex-1 items-center rounded-md border border-input bg-background pr-1 focus-within:border-ring",
              query.search && (!query.valid || total === 0) && "border-destructive/60 focus-within:border-destructive",
            )}
          >
            <input
              ref={findInput}
              // CodeMirror's openSearchPanel (⌘F in the editor) focuses and selects the [main-field] input.
              main-field="true"
              value={query.search}
              placeholder="Find"
              aria-label="Find"
              spellCheck={false}
              onChange={(e) => apply({ search: e.target.value }, true)}
              onKeyDown={(e) => {
                if (commonKeys(e)) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.shiftKey ? findPrevious : findNext)(view);
                }
              }}
              className="h-full min-w-0 flex-1 bg-transparent px-2 outline-none placeholder:text-muted-foreground"
            />
            <FindToggle label="Match case" keys={`${ALT_KEY}C`} on={query.caseSensitive} onClick={() => apply({ caseSensitive: !query.caseSensitive }, true)}>
              <CaseSensitive />
            </FindToggle>
            <FindToggle label="Match whole word" keys={`${ALT_KEY}W`} on={query.wholeWord} onClick={() => apply({ wholeWord: !query.wholeWord }, true)}>
              <WholeWord />
            </FindToggle>
            <FindToggle label="Use regular expression" keys={`${ALT_KEY}R`} on={query.regexp} onClick={() => apply({ regexp: !query.regexp }, true)}>
              <Regex />
            </FindToggle>
          </div>
          <span
            className={cn(
              "w-20 shrink-0 text-center tabular-nums",
              query.search && (!query.valid || total === 0) ? "text-destructive" : "text-muted-foreground",
            )}
            aria-live="polite"
          >
            {status}
          </span>
          <IconButton label="Previous match" keys="⇧Enter" onClick={() => findPrevious(view)} disabled={!total}>
            <ArrowUp />
          </IconButton>
          <IconButton label="Next match" keys="Enter" onClick={() => findNext(view)} disabled={!total}>
            <ArrowDown />
          </IconButton>
          <IconButton label="Close" keys={`Esc or ${MOD_KEY}F`} onClick={close}>
            <X />
          </IconButton>
        </div>
        {showReplace && !readOnly && (
          <div className="flex items-center gap-1">
            <input
              ref={replaceInput}
              value={query.replace}
              placeholder="Replace"
              aria-label="Replace"
              spellCheck={false}
              onChange={(e) => apply({ replace: e.target.value }, false)}
              onKeyDown={(e) => {
                if (commonKeys(e)) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (e.metaKey || e.ctrlKey) replaceAll(view);
                  else replaceNext(view);
                }
              }}
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 outline-none placeholder:text-muted-foreground focus:border-ring"
            />
            <span className="w-20 shrink-0" />
            <IconButton label="Replace" keys="Enter" onClick={() => replaceNext(view)} disabled={!total}>
              <Replace />
            </IconButton>
            <IconButton label="Replace all" keys={`${MOD_KEY}Enter`} onClick={() => replaceAll(view)} disabled={!total}>
              <ReplaceAll />
            </IconButton>
            <span className="size-6 shrink-0" />
          </div>
        )}
      </div>
    </div>
  );
}

function IconButton({
  label,
  keys,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string;
  keys?: string;
  onClick(): void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            // Keep the focus (and the selection) in the field while clicking.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClick}
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5",
              className,
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {keys && <span className="ml-1.5 text-muted-foreground">{keys}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
