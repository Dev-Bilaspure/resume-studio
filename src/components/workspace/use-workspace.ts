"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "@/lib/api";
import type { BuildState, FileEntry, ProjectSymbols, ResumeMeta, SystemStatus } from "@/lib/types";
import { useServerEvents } from "@/lib/use-events";

export interface Buffer {
  path: string;
  content: string;
  /** Content and hash as last saved/loaded: what's on disk as far as we know. */
  savedContent: string;
  savedHash: string;
  saving: boolean;
  /** The file changed on disk while you had unsaved edits (or a save was refused). */
  conflict: boolean;
}

export type SaveStatus = "saved" | "unsaved" | "saving" | "error" | "conflict";

const AUTOSAVE_KEY = "rs.autosave";
const AUTOSAVE_DELAY = 900;

function readAutosave(): boolean {
  try {
    return localStorage.getItem(AUTOSAVE_KEY) !== "off";
  } catch {
    return true;
  }
}

export interface EditorBridge {
  replaceContent(path: string, content: string): void;
  forget(path: string): void;
}

/**
 * Everything the editor page knows about one resume: metadata, files, open buffers (with autosave and
 * conflict detection), the latest build, and live updates from the server.
 */
export function useWorkspace(id: string, editor: React.RefObject<EditorBridge | null>) {
  const [meta, setMeta] = useState<ResumeMeta | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [build, setBuild] = useState<BuildState | null>(null);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [autosave, setAutosaveState] = useState(readAutosave);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [symbols, setSymbols] = useState<ProjectSymbols | null>(null);
  const filesRef = useRef<FileEntry[]>([]);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  const buffersRef = useRef(buffers);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inflight = useRef(new Map<string, Promise<boolean>>());

  useEffect(() => {
    buffersRef.current = buffers;
  }, [buffers]);

  const setAutosave = useCallback((on: boolean) => {
    setAutosaveState(on);
    try {
      localStorage.setItem(AUTOSAVE_KEY, on ? "on" : "off");
    } catch {
      // Not persisted.
    }
  }, []);

  const patchBuffer = useCallback((path: string, patch: Partial<Buffer> | ((b: Buffer) => Partial<Buffer>)) => {
    setBuffers((all) => {
      const b = all[path];
      if (!b) return all;
      const next = { ...b, ...(typeof patch === "function" ? patch(b) : patch) };
      const out = { ...all, [path]: next };
      buffersRef.current = out;
      return out;
    });
  }, []);

  // ---- Loading -----------------------------------------------------------------------------------------
  const refresh = useCallback(async () => {
    try {
      const data = await api.get(id);
      setMeta(data.meta);
      setFiles(data.files);
      setBuild(data.build);
      setLoadError(null);
      return data;
    } catch (e) {
      setLoadError((e as Error).message);
      return null;
    }
  }, [id]);

  const refreshSystem = useCallback(async () => {
    try {
      setSystem(await api.system());
    } catch {
      // Shown via the connection indicator.
    }
  }, []);

  const openFile = useCallback(
    async (path: string) => {
      const entry = filesRef.current.find((f) => f.path === path);
      if (entry && !entry.editable) {
        // Images, PDFs, fonts: shown in a viewer tab, not loaded into the editor.
        setTabs((t) => (t.includes(path) ? t : [...t, path]));
        setOpenPath(path);
        return;
      }
      if (!buffersRef.current[path]) {
        try {
          const f = await api.readFile(id, path);
          setBuffers((all) => {
            if (all[path]) return all;
            const out = { ...all, [path]: { path, content: f.content, savedContent: f.content, savedHash: f.hash, saving: false, conflict: false } };
            buffersRef.current = out;
            return out;
          });
        } catch (e) {
          toast.error(`Couldn't open ${path}`, { description: (e as Error).message });
          return;
        }
      }
      setTabs((t) => (t.includes(path) ? t : [...t, path]));
      setOpenPath(path);
    },
    [id],
  );

  // Completion data for the whole project; refreshed (debounced) whenever files change on disk,
  // which includes every save.
  const symbolsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshSymbols = useCallback(() => {
    if (symbolsTimer.current) clearTimeout(symbolsTimer.current);
    symbolsTimer.current = setTimeout(() => {
      api.symbols(id).then(setSymbols, () => {});
    }, 400);
  }, [id]);
  useEffect(() => {
    let cancelled = false;
    api.symbols(id).then(
      (s) => !cancelled && setSymbols(s),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await refresh();
      void refreshSystem();
      if (!cancelled && data) await openFile(data.meta.mainFile);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, refreshSystem, openFile]);

  // ---- Saving ------------------------------------------------------------------------------------------
  const save = useCallback(
    async (path: string, opts: { force?: boolean } = {}): Promise<boolean> => {
      const running = inflight.current.get(path);
      if (running) await running; // one save per file at a time, in order
      const b = buffersRef.current[path];
      if (!b) return true;
      if (b.content === b.savedContent && !opts.force) return true;
      if (b.conflict && !opts.force) return false;
      const t = timers.current.get(path);
      if (t) clearTimeout(t);
      const content = b.content;
      patchBuffer(path, { saving: true });
      const p = (async () => {
        try {
          const res = await api.saveFile(id, path, content, opts.force ? null : b.savedHash);
          patchBuffer(path, { savedContent: content, savedHash: res.hash, saving: false, conflict: false });
          setSaveError(null);
          return true;
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            patchBuffer(path, { saving: false, conflict: true });
          } else {
            patchBuffer(path, { saving: false });
            setSaveError((e as Error).message);
            toast.error(`Couldn't save ${path}`, { description: (e as Error).message });
          }
          return false;
        } finally {
          inflight.current.delete(path);
        }
      })();
      inflight.current.set(path, p);
      return p;
    },
    [id, patchBuffer],
  );

  const saveAll = useCallback(async () => {
    const results = await Promise.all(Object.keys(buffersRef.current).map((p) => save(p)));
    return results.every(Boolean);
  }, [save]);

  const change = useCallback(
    (path: string, content: string) => {
      patchBuffer(path, { content });
      if (!autosave) return;
      const t = timers.current.get(path);
      if (t) clearTimeout(t);
      timers.current.set(
        path,
        setTimeout(() => void save(path), AUTOSAVE_DELAY),
      );
    },
    [autosave, patchBuffer, save],
  );

  /** Save everything, then build even if nothing changed. */
  const compile = useCallback(async () => {
    await saveAll();
    try {
      await api.compile(id);
    } catch (e) {
      toast.error("Couldn't start the build", { description: (e as Error).message });
    }
  }, [id, saveAll]);

  // Saving with Cmd+S when nothing changed still rebuilds: it's how people ask for a refresh.
  const saveAndBuild = useCallback(async () => {
    const dirty = Object.values(buffersRef.current).some((b) => b.content !== b.savedContent);
    if (dirty) await saveAll();
    else await api.compile(id).catch(() => {});
  }, [id, saveAll]);

  // ---- Conflicts ---------------------------------------------------------------------------------------
  // Plain functions (not useCallback): they read the editor ref when called.
  const reloadFromDisk = async (path: string) => {
    const f = await api.readFile(id, path);
    patchBuffer(path, { content: f.content, savedContent: f.content, savedHash: f.hash, conflict: false });
    editor.current?.replaceContent(path, f.content);
  };

  const keepMine = useCallback((path: string) => save(path, { force: true }), [save]);

  // ---- Live updates ------------------------------------------------------------------------------------
  const filesRefresh = useRef<ReturnType<typeof setTimeout> | null>(null);
  useServerEvents(
    (e) => {
      if (e.type === "build-start" && e.resumeId === id) {
        setBuild((b) => (b ? { ...b, running: true } : b));
      } else if (e.type === "build" && e.result.resumeId === id) {
        setBuild((b) => ({
          resumeId: id,
          running: false,
          last: e.result,
          lastGood: e.result.status === "ok" ? e.result : (b?.lastGood ?? null),
        }));
      } else if (e.type === "files" && e.resumeId === id) {
        for (const c of e.changes) {
          const b = buffersRef.current[c.path];
          if (!b || c.hash === b.savedHash) continue; // our own save, or a file we don't have open
          if (b.saving) continue; // our save is landing; a real concurrent edit is caught by the next save's 409
          if (c.hash === null) continue; // deleted: the file list update below handles the tab
          if (b.content === b.savedContent && !b.saving) {
            void reloadFromDisk(c.path); // changed elsewhere, no local edits: follow the disk
          } else {
            patchBuffer(c.path, { conflict: true });
          }
        }
        refreshSymbols();
        if (filesRefresh.current) clearTimeout(filesRefresh.current);
        filesRefresh.current = setTimeout(async () => {
          const data = await api.get(id).catch(() => null);
          if (data) {
            setFiles(data.files);
            setMeta(data.meta);
          }
        }, 200);
      } else if (e.type === "resumes") {
        void api
          .get(id)
          .then((d) => {
            setMeta(d.meta);
            setFiles(d.files);
          })
          .catch((err) => {
            if (err instanceof ApiError && err.status === 404) setLoadError("This resume was deleted or moved.");
          });
      }
    },
    () => void refresh(),
  );

  // Tabs for files that no longer exist (deleted or renamed elsewhere) drop out.
  const existing = useMemo(() => new Set(files.filter((f) => f.kind === "file").map((f) => f.path)), [files]);
  const visibleTabs = useMemo(() => (files.length ? tabs.filter((p) => existing.has(p)) : tabs), [tabs, existing, files.length]);
  const currentPath = openPath && (!files.length || existing.has(openPath)) ? openPath : (meta?.mainFile ?? null);

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (ev: BeforeUnloadEvent) => {
      if (Object.values(buffersRef.current).some((b) => b.content !== b.savedContent)) ev.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const closeTab = useCallback(
    async (path: string) => {
      const b = buffersRef.current[path];
      if (b && b.content !== b.savedContent) await save(path);
      setTabs((t) => {
        const next = t.filter((p) => p !== path);
        if (openPath === path) setOpenPath(next.at(-1) ?? meta?.mainFile ?? null);
        return next;
      });
    },
    [openPath, meta, save],
  );

  const forgetFile = (path: string) => {
    setBuffers((all) => {
      const rest = { ...all };
      delete rest[path];
      buffersRef.current = rest;
      return rest;
    });
    editor.current?.forget(path);
    setTabs((t) => t.filter((p) => p !== path));
  };

  const saveStatus: SaveStatus = useMemo(() => {
    const all = Object.values(buffers);
    if (all.some((b) => b.conflict)) return "conflict";
    if (all.some((b) => b.saving)) return "saving";
    if (saveError) return "error";
    if (all.some((b) => b.content !== b.savedContent)) return "unsaved";
    return "saved";
  }, [buffers, saveError]);

  return {
    meta,
    setMeta,
    files,
    build,
    system,
    refreshSystem,
    loadError,
    buffers,
    openPath: currentPath,
    tabs: visibleTabs,
    openFile,
    closeTab,
    forgetFile,
    change,
    save,
    saveAll,
    saveAndBuild,
    compile,
    reloadFromDisk,
    keepMine,
    autosave,
    setAutosave,
    saveStatus,
    refresh,
    symbols,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
