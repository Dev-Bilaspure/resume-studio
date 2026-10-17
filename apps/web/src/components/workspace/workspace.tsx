"use client";

import {
  ArrowLeft,
  Check,
  ChevronDown,
  CircleX,
  Download,
  ExternalLink,
  FileWarning,
  GitCompare,
  Keyboard,
  Pencil,
  Loader2,
  Plus,
  RotateCcw,
  TriangleAlert,
  X,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePanelRef } from "react-resizable-panels";
import { toast } from "sonner";
import { LatexEditor, type LatexEditorHandle } from "@/components/editor/latex-editor";
import { NewResumeDialog } from "@/components/new-resume-dialog";
import { PdfPreview, type PdfPreviewHandle } from "@/components/preview/pdf-preview";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, type ResumeSummary } from "@/lib/api";
import { formatDuration, relativeTime } from "@/lib/format";
import { ENGINES, type BuildResult, type ResumeMeta, type SnapshotInfo } from "@/lib/types";
import { useConnected } from "@/lib/use-events";
import { cn } from "@/lib/utils";
import { useLayout } from "@/lib/use-layout";
import { useEditorSettings } from "@/lib/editor-settings";
import { AtsPanel } from "./ats-panel";
import { DiffDialog } from "./diff-dialog";
import { FileTree } from "./file-tree";
import { HistoryPanel, SnapshotButton } from "./history-panel";
import { ProblemsPanel, countBySeverity } from "./problems-panel";
import { FileViewer } from "./file-viewer";
import { OutlinePanel } from "./outline-panel";
import { ProjectMenu, RecompileButton } from "./project-menu";
import { SettingsDialog } from "./settings-dialog";
import { useWorkspace, type SaveStatus } from "./use-workspace";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";

function downloadName(result: BuildResult | null, fallback: string) {
  const who = result?.ats?.stats.author?.trim() || fallback;
  const base =
    who
      .replace(/\bresume\b/gi, "")
      .replace(/[^\p{L}\p{N}]+/gu, "_")
      .replace(/^_+|_+$/g, "") || "Resume";
  return `${base}_Resume.pdf`;
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  const map: Record<SaveStatus, { label: string; className: string; icon?: React.ReactNode }> = {
    saved: { label: "Saved", className: "text-muted-foreground", icon: <Check className="size-3" /> },
    unsaved: { label: "Unsaved", className: "text-muted-foreground", icon: <span className="size-1.5 rounded-full bg-foreground/60" /> },
    saving: { label: "Saving…", className: "text-muted-foreground", icon: <Loader2 className="size-3 animate-spin" /> },
    error: { label: "Not saved", className: "text-destructive", icon: <CircleX className="size-3" /> },
    conflict: { label: "Changed on disk", className: "text-warning", icon: <TriangleAlert className="size-3" /> },
  };
  const s = map[status];
  return (
    <span className={cn("flex items-center gap-1.5 text-xs", s.className)} aria-live="polite">
      {s.icon}
      {s.label}
    </span>
  );
}

function BuildPill({ running, result, onClick }: { running: boolean; result: BuildResult | null; onClick(): void }) {
  const counts = countBySeverity(result?.diagnostics ?? []);
  let content: React.ReactNode;
  let tone = "text-muted-foreground";
  if (running) {
    content = (
      <>
        <Loader2 className="size-3.5 animate-spin" />
        Compiling…
      </>
    );
  } else if (!result) {
    content = "Not compiled";
  } else if (result.status === "ok") {
    content = (
      <>
        <Check className="size-3.5 text-success" />
        Compiled in {formatDuration(result.durationMs)}
        {counts.warning > 0 && (
          <span className="text-warning tabular-nums">
            · {counts.warning} warning{counts.warning === 1 ? "" : "s"}
          </span>
        )}
      </>
    );
  } else if (result.status === "failed-to-start") {
    tone = "text-destructive";
    content = (
      <>
        <FileWarning className="size-3.5" />
        TeX not available
      </>
    );
  } else {
    tone = "text-destructive";
    content = (
      <>
        <CircleX className="size-3.5" />
        {result.status === "timeout" ? "Timed out" : `${counts.error || 1} error${counts.error === 1 ? "" : "s"}`}
      </>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cn("flex h-7 items-center gap-1.5 rounded-md px-2 text-xs tabular-nums hover:bg-muted", tone)}>
      {content}
    </button>
  );
}

function ShortcutsHelp() {
  const rows: [string, string[]][] = [
    ["Save & compile", [MOD, "S"]],
    ["Recompile now", [MOD, "↵"]],
    ["Show cursor position in PDF", [MOD, "J"]],
    ["Jump from PDF to source", ["Double-click"]],
    ["Find / replace", [MOD, "F"]],
    ["Toggle comment", [MOD, "/"]],
    ["Autocomplete", ["Ctrl", "Space"]],
    ["Zoom preview", [MOD, "scroll"]],
  ];
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" />}>
        <Keyboard />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <p className="mb-2 text-sm font-medium">Shortcuts</p>
        <ul className="grid gap-1.5 text-xs">
          {rows.map(([label, keys]) => (
            <li key={label} className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">{label}</span>
              <span className="flex gap-1">
                {keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** The resume's name: click to rename it in place (Enter or clicking away saves, Escape cancels). */
function ResumeName({
  id,
  name,
  editing,
  onEditing,
  onRenamed,
}: {
  id: string;
  name: string;
  editing: boolean;
  onEditing(v: boolean): void;
  onRenamed(meta: ResumeMeta): void;
}) {
  const [saving, setSaving] = useState<string | null>(null);

  const save = async (next: string) => {
    onEditing(false);
    if (!next || next === name) return;
    setSaving(next);
    try {
      onRenamed(await api.update(id, { name: next }));
    } catch (e) {
      toast.error("Couldn't rename the resume", { description: (e as Error).message });
    } finally {
      setSaving(null);
    }
  };

  if (editing) return <RenameInput name={name} onDone={(next) => void (next === null ? onEditing(false) : save(next))} />;
  return (
    <button
      type="button"
      onClick={() => onEditing(true)}
      title="Rename"
      className="max-w-72 truncate rounded-md px-2 py-1 text-sm font-medium hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {saving !== null ? <span className="text-muted-foreground">{saving}</span> : name}
    </button>
  );
}

/** Mounted for each edit, so it starts from the current name. `onDone(null)` cancels. */
function RenameInput({ name, onDone }: { name: string; onDone(next: string | null): void }) {
  const [draft, setDraft] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  // Selected, so typing replaces the name and the arrow keys keep it.
  useEffect(() => input.current?.select(), []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(save ? draft.trim() : null);
  };
  return (
    <input
      ref={input}
      autoFocus
      value={draft}
      maxLength={120}
      aria-label="Resume name"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      }}
      // As wide as the name being typed, within limits.
      style={{ width: `${Math.min(Math.max(draft.length, 8), 40) + 2}ch` }}
      className="h-7 rounded-md border border-ring bg-background px-2 text-sm font-medium ring-3 ring-ring/30 outline-none"
    />
  );
}

function ResumeSwitcher({ currentId, name, onRenamed }: { currentId: string; name: string; onRenamed(meta: ResumeMeta): void }) {
  const router = useRouter();
  const [list, setList] = useState<ResumeSummary[]>([]);
  const [creating, setCreating] = useState<null | "new" | "duplicate">(null);
  const [renaming, setRenaming] = useState(false);
  return (
    <>
      <ResumeName id={currentId} name={name} editing={renaming} onEditing={setRenaming} onRenamed={onRenamed} />
      <DropdownMenu onOpenChange={(o) => o && void api.list().then((d) => setList(d.resumes))}>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="-ml-1.5" aria-label="Switch resume" title="Switch resume" />}>
          <ChevronDown className="opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Resumes</DropdownMenuLabel>
            {list.map((r) => (
              <DropdownMenuItem key={r.id} onClick={() => r.id !== currentId && router.push(`/r/${encodeURIComponent(r.id)}`)}>
                <span className="flex-1 truncate">{r.name}</span>
                {r.id === currentId ? (
                  <Check className="text-primary" />
                ) : (
                  <span className="text-[11px] text-muted-foreground">{relativeTime(Date.parse(r.updatedAt))}</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setRenaming(true)}>
            <Pencil />
            Rename…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setCreating("duplicate")}>
            <GitCompare />
            Duplicate this resume…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setCreating("new")}>
            <Plus />
            New resume…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/")}>
            <ArrowLeft />
            All resumes
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NewResumeDialog
        open={creating !== null}
        onOpenChange={(o) => !o && setCreating(null)}
        duplicateOf={creating === "duplicate" ? { id: currentId, name } : null}
      />
    </>
  );
}

export function WorkspaceView({ id }: { id: string }) {
  const editorRef = useRef<LatexEditorHandle>(null);
  const previewRef = useRef<PdfPreviewHandle>(null);
  const ws = useWorkspace(id, editorRef);
  const connected = useConnected();
  const problemsPanel = usePanelRef();
  const mainLayout = useLayout("rs.layout.main");
  const editorLayout = useLayout("rs.layout.editor");

  const [leftTab, setLeftTab] = useState<"files" | "outline" | "history">("files");
  const editorSettings = useEditorSettings();
  const [rightTab, setRightTab] = useState<"preview" | "ats">("preview");
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [jump, setJump] = useState<{ file: string; line: number; col: number; n: number } | null>(null);
  const [showPartial, setShowPartial] = useState(false);
  const [viewing, setViewing] = useState<{ snap: SnapshotInfo; result: BuildResult | null; error?: string } | null>(null);
  const [comparing, setComparing] = useState<SnapshotInfo | null>(null);

  const last = ws.build?.last ?? null;
  const lastGood = ws.build?.lastGood ?? null;
  const failed = !!last && last.status !== "ok";

  useEffect(() => {
    if (!failed) setShowPartial(false);
  }, [failed]);

  // What the preview shows: a snapshot you're looking at, a partial PDF on request, or the last good build.
  const previewUrl = viewing ? (viewing.result?.pdfUrl ?? null) : showPartial && last?.partialPdfUrl ? last.partialPdfUrl : (lastGood?.pdfUrl ?? null);

  // ---- Jumping to a line (problems, ATS checks, PDF double-click) ----------------------------------------
  const jumpTo = useCallback(
    async (file: string, line: number, col = 0) => {
      await ws.openFile(file);
      setJump({ file, line, col, n: Date.now() });
    },
    [ws],
  );

  // Runs after the editor (a child, so its effects run first) has switched to the file.
  useEffect(() => {
    if (!jump || ws.openPath !== jump.file || !ws.buffers[jump.file]) return;
    editorRef.current?.goto(jump.line, jump.col);
    setJump(null);
  }, [jump, ws.openPath, ws.buffers]);

  const forwardSync = useCallback(
    async (line: number) => {
      if (!lastGood || !ws.openPath || viewing) return;
      setRightTab("preview");
      try {
        const { boxes } = await api.forwardSync(id, lastGood.id, ws.openPath, line);
        if (boxes.length) previewRef.current?.highlight(boxes);
        else toast("Nothing on the page for that line", { description: "Comments, preamble and blank lines have no position in the PDF." });
      } catch (e) {
        toast.error("Couldn't locate that line in the PDF", { description: (e as Error).message });
      }
    },
    [id, lastGood, ws.openPath, viewing],
  );

  const inverseSync = useCallback(
    async (page: number, x: number, y: number) => {
      if (!lastGood || viewing || showPartial) return;
      try {
        const hit = await api.inverseSync(id, lastGood.id, page, x, y);
        if (hit) await jumpTo(hit.file, hit.line, hit.column);
      } catch (e) {
        toast.error("Couldn't find the source for that spot", { description: (e as Error).message });
      }
    },
    [id, lastGood, viewing, showPartial, jumpTo],
  );

  // ---- Global shortcuts (when focus isn't in the editor, which handles its own) ---------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      if ((e.target as HTMLElement)?.closest?.(".cm-editor")) return;
      if (e.key === "s") {
        e.preventDefault();
        void ws.saveAndBuild();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void ws.compile();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ws]);

  // ---- Snapshot viewing ---------------------------------------------------------------------------------
  const viewSnapshot = useCallback(
    async (snap: SnapshotInfo | null) => {
      if (!snap) {
        setViewing(null);
        return;
      }
      setRightTab("preview");
      setViewing({ snap, result: null });
      try {
        const result = await api.previewSnapshot(id, snap.sha);
        setViewing((v) => (v?.snap.sha === snap.sha ? { snap, result, error: result.pdfUrl ? undefined : "This snapshot doesn't compile." } : v));
      } catch (e) {
        setViewing((v) => (v?.snap.sha === snap.sha ? { snap, result: null, error: (e as Error).message } : v));
      }
    },
    [id],
  );

  const currentContent = useCallback(
    async (path: string) => {
      const b = ws.buffers[path];
      if (b) return b.content;
      return api
        .readFile(id, path)
        .then((f) => f.content)
        .catch(() => null);
    },
    [id, ws.buffers],
  );

  const dirty = useMemo(
    () =>
      new Set(
        Object.values(ws.buffers)
          .filter((b) => b.content !== b.savedContent)
          .map((b) => b.path),
      ),
    [ws.buffers],
  );
  const currentDiagnostics = useMemo(() => (last?.diagnostics ?? []).filter((d) => d.file === ws.openPath), [last, ws.openPath]);
  const openBuffer = ws.openPath ? ws.buffers[ws.openPath] : undefined;
  // The editor stays mounted (keeping every file's undo history) while an image or PDF tab is shown.
  const textPath = openBuffer ? ws.openPath : ([...ws.tabs].reverse().find((p) => ws.buffers[p]) ?? null);
  const textBuffer = textPath ? ws.buffers[textPath] : undefined;
  const binaryFile = !openBuffer && ws.openPath ? ws.files.find((f) => f.path === ws.openPath && !f.editable) : undefined;
  const textFiles = useMemo(() => ws.files.filter((f) => f.kind === "file").map((f) => f.path), [ws.files]);

  if (ws.loadError && !ws.meta) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="font-medium">{ws.loadError}</p>
        <Button variant="outline" nativeButton={false} render={<Link href="/" />}>
          <ArrowLeft />
          All resumes
        </Button>
      </div>
    );
  }
  if (!ws.meta) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Opening…
      </div>
    );
  }

  const meta = ws.meta;
  const texMissing = ws.system && !ws.system.tex.available;
  const pdfForDownload = lastGood?.pdfUrl;

  return (
    <div className="flex h-full flex-col">
      {/* ---- Top bar ---- */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur-md">
        <Link href="/" className="flex items-center gap-2 pr-1 text-sm font-semibold tracking-tight" title="All resumes">
          <span className="size-2.5 rounded-[3px] bg-primary" aria-hidden />
          <span className="hidden lg:inline">Resume Studio</span>
        </Link>
        <span className="text-muted-foreground/50">/</span>
        <ResumeSwitcher currentId={id} name={meta.name} onRenamed={ws.setMeta} />
        {meta.application && (
          <Link
            href={`/tailor/${meta.application.session}`}
            className="hidden max-w-64 items-center gap-1 truncate rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary hover:bg-primary/15 md:flex"
            title={`Tailored for ${meta.application.role} at ${meta.application.company}. Open the review.`}
          >
            <Sparkles className="size-3 shrink-0" />
            <span className="truncate">{meta.application.company}</span>
          </Link>
        )}
        <SaveIndicator status={ws.saveStatus} />
        <div className="ml-auto flex items-center gap-1.5">
          <BuildPill
            running={!!ws.build?.running}
            result={last}
            onClick={() => {
              const p = problemsPanel.current;
              if (p?.isCollapsed()) p.expand();
            }}
          />
          <RecompileButton
            running={!!ws.build?.running}
            meta={meta}
            autosave={ws.autosave}
            onAutosave={ws.setAutosave}
            onCompile={() => void ws.compile()}
            onClean={async () => {
              await ws.saveAll();
              await api.clean(id).catch((e) => toast.error("Couldn't clear the cache", { description: (e as Error).message }));
            }}
            onChanged={ws.setMeta}
            shortcut={
              <>
                <Kbd>{MOD}</Kbd>
                <Kbd>↵</Kbd>
              </>
            }
          />
          <Button
            size="sm"
            variant="outline"
            nativeButton={false}
            render={<Link href={`/tailor/new?resume=${encodeURIComponent(id)}`} />}
            title="Tailor this resume for a job description"
          >
            <Sparkles />
            <span className="hidden xl:inline">Tailor</span>
          </Button>
          <SnapshotButton resumeId={id} beforeAction={ws.saveAll} />
          <Button
            size="sm"
            disabled={!pdfForDownload}
            nativeButton={false}
            render={<a href={pdfForDownload ? `${pdfForDownload}?download=${encodeURIComponent(downloadName(lastGood, meta.name))}` : undefined} />}
          >
            <Download />
            PDF
          </Button>
          <ProjectMenu resumeId={id} />
          <SettingsDialog meta={meta} files={ws.files} system={ws.system} autosave={ws.autosave} onAutosave={ws.setAutosave} onChanged={ws.setMeta} />
          <ShortcutsHelp />
        </div>
      </header>

      {texMissing && (
        <div className="flex shrink-0 items-center gap-3 border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm">
          <TriangleAlert className="size-4 shrink-0 text-warning" />
          <span className="flex-1">
            TeX isn&apos;t installed, so nothing can compile. Install MacTeX:{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">brew install --cask mactex-no-gui</code>, then check again.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await ws.refreshSystem();
              await ws.compile();
            }}
          >
            Check again
          </Button>
        </div>
      )}
      {!connected && (
        <div className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-1.5 text-xs">
          <Loader2 className="size-3.5 animate-spin" />
          Lost connection to the Resume Studio server. Reconnecting… Your edits are kept in this tab.
        </div>
      )}

      {/* ---- Panes ---- */}
      <ResizablePanelGroup
        orientation="horizontal"
        id="rs-main"
        defaultLayout={mainLayout.defaultLayout}
        onLayoutChanged={mainLayout.onLayoutChanged}
        className="min-h-0 flex-1"
      >
        <ResizablePanel id="left" defaultSize="17%" minSize={180} maxSize="35%" collapsible collapsedSize={0} className="bg-sidebar">
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 gap-1 border-b px-2 py-1.5 text-xs">
              {(["files", "outline", "history"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setLeftTab(t)}
                  className={cn(
                    "rounded-md px-2 py-1 font-medium capitalize text-muted-foreground hover:text-foreground",
                    leftTab === t && "bg-muted text-foreground",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1">
              {leftTab === "files" ? (
                <FileTree
                  resumeId={id}
                  files={ws.files}
                  mainFile={meta.mainFile}
                  openPath={ws.openPath}
                  dirty={dirty}
                  onOpen={(p) => void ws.openFile(p)}
                  onSetMain={(p) => void api.update(id, { mainFile: p }).then(ws.setMeta)}
                  onDeleted={(p) => ws.forgetFile(p)}
                  onRenamed={(from, to) => {
                    ws.forgetFile(from);
                    void ws.openFile(to);
                  }}
                />
              ) : leftTab === "outline" ? (
                <OutlinePanel
                  path={textPath}
                  content={textBuffer?.content ?? null}
                  cursorLine={cursor.line}
                  onJump={(line) => textPath && void jumpTo(textPath, line)}
                />
              ) : (
                <HistoryPanel
                  resumeId={id}
                  previewingSha={viewing?.snap.sha ?? null}
                  onPreview={(s) => void viewSnapshot(s)}
                  onCompare={setComparing}
                  beforeAction={ws.saveAll}
                  onRestored={() => {
                    for (const p of Object.keys(ws.buffers)) void ws.reloadFromDisk(p).catch(() => ws.forgetFile(p));
                  }}
                />
              )}
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="editor" defaultSize="41%" minSize={320}>
          <ResizablePanelGroup orientation="vertical" id="rs-editor" defaultLayout={editorLayout.defaultLayout} onLayoutChanged={editorLayout.onLayoutChanged}>
            <ResizablePanel id="code" defaultSize="78%" minSize={160}>
              <div className="flex h-full min-h-0 flex-col">
                {/* Tabs */}
                <div className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b px-1.5">
                  {ws.tabs.map((p) => (
                    <div
                      key={p}
                      className={cn(
                        "group flex h-8 items-center gap-1.5 rounded-t-md border border-b-0 border-transparent px-2.5 font-mono text-[12px] text-muted-foreground",
                        p === ws.openPath && "border-border bg-background text-foreground",
                      )}
                    >
                      <button type="button" onClick={() => void ws.openFile(p)} className="max-w-48 truncate">
                        {p}
                      </button>
                      {dirty.has(p) ? <span className="size-1.5 rounded-full bg-foreground/70 group-hover:hidden" aria-label="Unsaved" /> : null}
                      {ws.tabs.length > 1 && (
                        <button
                          type="button"
                          aria-label={`Close ${p}`}
                          onClick={() => void ws.closeTab(p)}
                          className={cn("rounded p-0.5 hover:bg-muted", dirty.has(p) ? "hidden group-hover:block" : "opacity-0 group-hover:opacity-100")}
                        >
                          <X className="size-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {openBuffer?.conflict && (
                  <div className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-xs">
                    <TriangleAlert className="size-3.5 shrink-0 text-warning" />
                    <span className="flex-1">{openBuffer.path} changed on disk (another editor, or a restore) while you had unsaved edits.</span>
                    <Button size="xs" variant="outline" onClick={() => void ws.reloadFromDisk(openBuffer.path)}>
                      Use the disk version
                    </Button>
                    <Button size="xs" variant="outline" onClick={() => void ws.keepMine(openBuffer.path)}>
                      Keep mine
                    </Button>
                  </div>
                )}
                <div className="relative min-h-0 flex-1">
                  {binaryFile && (
                    <div className="absolute inset-0 z-10 bg-background">
                      <FileViewer resumeId={id} file={binaryFile} />
                    </div>
                  )}
                  {textPath && textBuffer ? (
                    <LatexEditor
                      ref={editorRef}
                      path={textPath}
                      initialContent={textBuffer.content}
                      settings={editorSettings}
                      symbols={ws.symbols}
                      diagnostics={currentDiagnostics}
                      onChange={ws.change}
                      onSave={() => void ws.saveAndBuild()}
                      onCompile={() => void ws.compile()}
                      onForwardSync={(line) => void forwardSync(line)}
                      onCursor={(line, col) => setCursor({ line, col })}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      Loading…
                    </div>
                  )}
                </div>
              </div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="problems" panelRef={problemsPanel} defaultSize="22%" minSize={90} collapsible collapsedSize={0}>
              <ProblemsPanel resumeId={id} result={last} onJump={(f, l) => void jumpTo(f, l)} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="right" defaultSize="42%" minSize={320}>
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5 text-xs">
              <button
                type="button"
                onClick={() => setRightTab("preview")}
                className={cn(
                  "rounded-md px-2 py-1 font-medium text-muted-foreground hover:text-foreground",
                  rightTab === "preview" && "bg-muted text-foreground",
                )}
              >
                Preview
              </button>
              <button
                type="button"
                onClick={() => setRightTab("ats")}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-muted-foreground hover:text-foreground",
                  rightTab === "ats" && "bg-muted text-foreground",
                )}
              >
                ATS check
                {lastGood?.ats && !lastGood.ats.unavailable && (
                  <span
                    className={cn(
                      "rounded px-1 text-[10.5px] tabular-nums",
                      lastGood.ats.score >= 90
                        ? "bg-success/15 text-success"
                        : lastGood.ats.score >= 70
                          ? "bg-warning/15 text-warning"
                          : "bg-destructive/15 text-destructive",
                    )}
                  >
                    {lastGood.ats.score}
                  </span>
                )}
              </button>
            </div>

            {/* The preview stays mounted and laid out under the ATS panel: PDF.js can't measure (fit width,
                scroll) inside a display:none element, and switching tabs never reloads the PDF. */}
            <div className="relative flex min-h-0 flex-1 flex-col">
              <div className={cn("flex min-h-0 flex-1 flex-col", rightTab !== "preview" && "invisible")} aria-hidden={rightTab !== "preview"}>
                {viewing && (
                  <div className="flex shrink-0 items-center gap-2 border-b border-primary/30 bg-primary/10 px-3 py-1.5 text-xs">
                    <span className="min-w-0 flex-1 truncate">
                      Viewing snapshot <span className="font-medium">“{viewing.snap.message}”</span> · {new Date(viewing.snap.createdAt).toLocaleString()}
                    </span>
                    <Button size="xs" variant="outline" onClick={() => setComparing(viewing.snap)}>
                      <GitCompare />
                      Compare
                    </Button>
                    <Button
                      size="xs"
                      onClick={async () => {
                        const snap = viewing.snap;
                        try {
                          await ws.saveAll();
                          await api.restoreSnapshot(id, snap.sha);
                          setViewing(null);
                          for (const p of Object.keys(ws.buffers)) void ws.reloadFromDisk(p).catch(() => ws.forgetFile(p));
                          toast.success("Restored", { description: "Your previous version was saved as a snapshot first, so this can be undone." });
                        } catch (e) {
                          toast.error("Restore failed", { description: (e as Error).message });
                        }
                      }}
                    >
                      <RotateCcw />
                      Restore
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setViewing(null)}>
                      <X />
                      Back to current
                    </Button>
                  </div>
                )}
                {!viewing && failed && last && (
                  <div className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs">
                    <CircleX className="size-3.5 shrink-0 text-destructive" />
                    <span className="flex-1">
                      {showPartial
                        ? "Showing the partial output of the failed build."
                        : lastGood
                          ? "The last build failed. Showing the last good version."
                          : "The build failed."}
                    </span>
                    {last.partialPdfUrl && (
                      <Button size="xs" variant="outline" onClick={() => setShowPartial((v) => !v)}>
                        {showPartial ? "Show last good" : "Show partial output"}
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        const p = problemsPanel.current;
                        if (p?.isCollapsed()) p.expand();
                      }}
                    >
                      View problems
                    </Button>
                  </div>
                )}
                <PdfPreview
                  ref={previewRef}
                  url={previewUrl}
                  onInverseSync={(page, x, y) => void inverseSync(page, x, y)}
                  onError={(m) => toast.error("Couldn't display the PDF", { description: m })}
                  className="min-h-0 flex-1"
                  toolbarExtra={
                    previewUrl && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Open PDF in a new tab"
                              nativeButton={false}
                              render={<a href={previewUrl} target="_blank" rel="noopener" />}
                            />
                          }
                        >
                          <ExternalLink />
                        </TooltipTrigger>
                        <TooltipContent>Open in a new tab</TooltipContent>
                      </Tooltip>
                    )
                  }
                />
                {!previewUrl && (
                  <div className="pointer-events-none absolute inset-0 top-10 flex items-center justify-center p-8 text-center">
                    {viewing ? (
                      viewing.error ? (
                        <p className="text-sm text-muted-foreground">{viewing.error}</p>
                      ) : (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="size-4 animate-spin" />
                          Rendering the snapshot…
                        </p>
                      )
                    ) : ws.build?.running || !last ? (
                      <p className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        Compiling…
                      </p>
                    ) : (
                      <div className="max-w-sm text-sm text-muted-foreground">
                        <p className="font-medium text-foreground">No PDF yet</p>
                        <p className="mt-1">Fix the problems below and save; the preview updates on every successful build.</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
              {rightTab === "ats" && (
                <div className="absolute inset-0 z-10 bg-background">
                  <AtsPanel report={lastGood?.ats ?? null} stale={failed && !!lastGood} onJump={(f, l) => void jumpTo(f, l)} />
                </div>
              )}
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* ---- Status bar ---- */}
      <footer className="flex h-6 shrink-0 items-center gap-3 border-t bg-sidebar px-3 text-[11px] text-muted-foreground tabular-nums">
        <span>
          Ln {cursor.line}, Col {cursor.col}
        </span>
        <span className="font-mono">{ws.openPath}</span>
        <span className="ml-auto">
          {ENGINES.find((e) => e.id === (last?.engine ?? meta.engine))?.label}
          {last?.engine && last.engine !== meta.engine && (
            <span className="text-muted-foreground/70"> (instead of {ENGINES.find((e) => e.id === meta.engine)?.label})</span>
          )}
        </span>
        {ws.system?.tex.version && <span>{ws.system.tex.version}</span>}
        {lastGood && <span title={new Date(lastGood.startedAt).toLocaleString()}>Last good build {relativeTime(lastGood.startedAt)}</span>}
        <span className="flex items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-destructive")} />
          {connected ? "Live" : "Offline"}
        </span>
      </footer>

      <DiffDialog resumeId={id} snapshot={comparing} currentContent={currentContent} currentFiles={textFiles} onOpenChange={(o) => !o && setComparing(null)} />
    </div>
  );
}
