"use client";

import { File, FileCode2, FilePlus, Folder, FolderPlus, Image as ImageIcon, Star, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { FileEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  resumeId: string;
  files: FileEntry[];
  mainFile: string;
  openPath: string | null;
  dirty: Set<string>;
  onOpen(path: string): void;
  onSetMain(path: string): void;
  onDeleted(path: string): void;
  onRenamed(from: string, to: string): void;
}

function iconFor(f: FileEntry) {
  if (f.kind === "dir") return <Folder className="size-3.5 shrink-0 text-muted-foreground" />;
  if (/\.(tex|cls|sty|bib)$/.test(f.path)) return <FileCode2 className="size-3.5 shrink-0 text-primary/80" />;
  if (/\.(png|jpe?g|gif|svg|pdf|webp)$/i.test(f.path)) return <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  return <File className="size-3.5 shrink-0 text-muted-foreground" />;
}

type Editing = { mode: "new-file" | "new-dir" } | { mode: "rename"; path: string };

export function FileTree({ resumeId, files, mainFile, openPath, dirty, onOpen, onSetMain, onDeleted, onRenamed }: Props) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const upload = useRef<HTMLInputElement>(null);

  const startEdit = (e: Editing) => {
    setEditing(e);
    setName(e.mode === "rename" ? e.path : e.mode === "new-file" ? "section.tex" : "");
  };

  const commit = async () => {
    const value = name.trim().replace(/^\/+/, "");
    const e = editing;
    setEditing(null);
    if (!e || !value) return;
    try {
      if (e.mode === "rename") {
        if (value === e.path) return;
        await api.renameFile(resumeId, e.path, value);
        onRenamed(e.path, value);
      } else {
        await api.createFile(resumeId, value, e.mode === "new-dir" ? "dir" : "file");
        if (e.mode === "new-file") onOpen(value);
      }
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const onUpload = async (list: FileList | null) => {
    if (!list) return;
    for (const f of Array.from(list)) {
      try {
        await api.upload(resumeId, f.name, f);
        toast.success(`Added ${f.name}`);
      } catch (err) {
        toast.error(`Couldn't add ${f.name}`, { description: (err as Error).message });
      }
    }
    if (upload.current) upload.current.value = "";
  };

  const depth = (p: string) => p.split("/").length - 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-0.5 px-2">
        <span className="flex-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Files</span>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="New file" onClick={() => startEdit({ mode: "new-file" })} />}>
            <FilePlus />
          </TooltipTrigger>
          <TooltipContent>New file</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="New folder" onClick={() => startEdit({ mode: "new-dir" })} />}>
            <FolderPlus />
          </TooltipTrigger>
          <TooltipContent>New folder</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Upload" onClick={() => upload.current?.click()} />}>
            <Upload />
          </TooltipTrigger>
          <TooltipContent>Add files (class files, fonts, images)</TooltipContent>
        </Tooltip>
        <input ref={upload} type="file" multiple hidden onChange={(e) => void onUpload(e.target.files)} />
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto px-1.5 pb-4"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void onUpload(e.dataTransfer.files);
        }}
      >
        {editing && editing.mode !== "rename" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void commit();
            }}
            className="px-1 py-1"
          >
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void commit()}
              onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
              placeholder={editing.mode === "new-dir" ? "folder" : "file.tex"}
              className="h-7 font-mono text-xs"
            />
          </form>
        )}
        <ul>
          {files.map((f) => {
            const isMain = f.path === mainFile;
            const renaming = editing?.mode === "rename" && editing.path === f.path;
            return (
              <li key={f.path}>
                {renaming ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void commit();
                    }}
                    className="px-1 py-0.5"
                  >
                    <Input
                      autoFocus
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      onBlur={() => void commit()}
                      onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
                      className="h-7 font-mono text-xs"
                    />
                  </form>
                ) : (
                  <ContextMenu>
                    <ContextMenuTrigger
                      render={
                        <button
                          type="button"
                          disabled={f.kind === "dir"}
                          onClick={() => onOpen(f.path)}
                          style={{ paddingLeft: `${8 + depth(f.path) * 12}px` }}
                          className={cn(
                            "group flex w-full items-center gap-2 rounded-md py-1 pr-2 text-left font-mono text-[12.5px] text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent",
                            openPath === f.path && "bg-muted text-foreground",
                          )}
                        />
                      }
                    >
                      {iconFor(f)}
                      <span className="truncate">{f.path.split("/").pop()}</span>
                      {isMain && <Star className="size-3 shrink-0 fill-current text-warning" aria-label="Main file" />}
                      {dirty.has(f.path) && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-foreground/70" aria-label="Unsaved" />}
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-48">
                      {f.kind === "file" && /\.(tex|xtx|ltx)$/.test(f.path) && !isMain && (
                        <ContextMenuItem onClick={() => onSetMain(f.path)}>Set as main file</ContextMenuItem>
                      )}
                      <ContextMenuItem onClick={() => startEdit({ mode: "rename", path: f.path })}>Rename…</ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem variant="destructive" disabled={isMain} onClick={() => setDeleting(f.path)}>
                        Delete
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting}?</AlertDialogTitle>
            <AlertDialogDescription>It stays in this resume&apos;s snapshot history if it was ever snapshotted.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const p = deleting;
                setDeleting(null);
                if (!p) return;
                try {
                  await api.deleteFile(resumeId, p);
                  onDeleted(p);
                } catch (err) {
                  toast.error((err as Error).message);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
