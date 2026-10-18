"use client";

import { useMemo } from "react";
import { parseOutline } from "@/components/editor/latex-language";
import { cn } from "@/lib/utils";

interface Props {
  path: string | null;
  content: string | null;
  /** Line the cursor is on, to highlight the section you're in. */
  cursorLine: number;
  onJump(line: number): void;
}

/** The open file's headings (Overleaf's "File outline"), updated as you type. */
export function OutlinePanel({ path, content, cursorLine, onJump }: Props) {
  const items = useMemo(() => (content ? parseOutline(content) : []), [content]);
  const minLevel = items.length ? Math.min(...items.map((i) => i.level)) : 0;
  const current = items.filter((i) => i.line <= cursorLine).at(-1)?.line ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center px-3">
        <span className="flex-1 truncate text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Outline</span>
        {path && <span className="truncate font-mono text-[11px] text-muted-foreground">{path}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-4">
        {!content ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">Open a .tex file to see its outline.</p>
        ) : items.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">No \section, \subsection or \chapter headings in this file.</p>
        ) : (
          <ul>
            {items.map((i) => (
              <li key={`${i.line}-${i.title}`}>
                <button
                  type="button"
                  onClick={() => onJump(i.line)}
                  style={{ paddingLeft: `${8 + (i.level - minLevel) * 14}px` }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md py-1 pr-2 text-left text-[13px] text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    i.level - minLevel === 0 && "font-medium text-foreground/90",
                    current === i.line && "bg-muted text-foreground",
                  )}
                >
                  <span className="truncate">{i.title}</span>
                  <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground/70 tabular-nums">{i.line}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
