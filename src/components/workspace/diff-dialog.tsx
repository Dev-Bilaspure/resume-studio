"use client";

import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { latexSupport } from "@/components/editor/latex-language";
import { editorTheme } from "@/components/editor/theme";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import type { SnapshotInfo } from "@/lib/types";

interface Props {
  resumeId: string;
  snapshot: SnapshotInfo | null;
  /** Current content of a file: the open buffer if there is one, else what's on disk. */
  currentContent(path: string): Promise<string | null>;
  currentFiles: string[];
  onOpenChange(open: boolean): void;
}

const readOnly = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  EditorView.lineWrapping,
  lineNumbers(),
  latexSupport({ getSymbols: () => null }),
  editorTheme,
];

/** Side-by-side diff of one file: the snapshot (left) against your current version (right). */
export function DiffDialog({ resumeId, snapshot, currentContent, currentFiles, onOpenChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ same: boolean } | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    void api.snapshotFiles(resumeId, snapshot.sha).then(
      ({ files: snapFiles }) => {
        setError(null);
        const text = [...new Set([...snapFiles, ...currentFiles])].filter((f) => /\.(tex|cls|sty|bib|txt|md)$/.test(f)).sort();
        setFiles(text);
        setFile((f) => (f && text.includes(f) ? f : (text.find((x) => x.endsWith("main.tex")) ?? text[0] ?? "")));
      },
      (e) => setError((e as Error).message),
    );
  }, [snapshot, resumeId, currentFiles]);

  useEffect(() => {
    if (!snapshot || !file || !host.current) return;
    let view: MergeView | null = null;
    let cancelled = false;
    void (async () => {
      const [before, after] = await Promise.all([
        api
          .snapshotFile(resumeId, snapshot.sha, file)
          .then((r) => r.content)
          .catch(() => ""),
        currentContent(file).then((c) => c ?? ""),
      ]);
      if (cancelled || !host.current) return;
      host.current.innerHTML = "";
      setStats({ same: before === after });
      view = new MergeView({
        a: { doc: before, extensions: readOnly },
        b: { doc: after, extensions: readOnly },
        parent: host.current,
        collapseUnchanged: { margin: 3, minSize: 6 },
        gutter: true,
        highlightChanges: true,
      });
    })();
    return () => {
      cancelled = true;
      view?.destroy();
    };
  }, [snapshot, file, resumeId, currentContent]);

  return (
    <Dialog open={!!snapshot} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-w-[min(1200px,calc(100%-2rem))] flex-col gap-3 p-0 sm:max-w-[min(1200px,calc(100%-2rem))]">
        <DialogHeader className="border-b px-4 pt-4 pb-3">
          <DialogTitle>Compare with snapshot</DialogTitle>
          <DialogDescription>
            Left: “{snapshot?.message}” ({snapshot && new Date(snapshot.createdAt).toLocaleString()}). Right: your current version.
          </DialogDescription>
          <div className="flex items-center gap-2 pt-1">
            <Select value={file} onValueChange={(v) => setFile(String(v))}>
              <SelectTrigger size="sm" className="min-w-48 font-mono text-xs">
                <SelectValue placeholder="Choose a file" />
              </SelectTrigger>
              <SelectContent>
                {files.map((f) => (
                  <SelectItem key={f} value={f} className="font-mono text-xs">
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {stats?.same && <span className="text-xs text-muted-foreground">No differences in this file.</span>}
          </div>
        </DialogHeader>
        {error ? <p className="px-4 text-sm text-destructive">{error}</p> : <div ref={host} className="diff-host min-h-0 flex-1 overflow-auto" />}
      </DialogContent>
    </Dialog>
  );
}
