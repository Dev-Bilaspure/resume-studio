"use client";

import { Settings2, ShieldAlert, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { setEditorSettings, useEditorSettings, type KeymapMode } from "@/lib/editor-settings";
import { ENGINES, type Engine, type FileEntry, type ResumeMeta, type SystemStatus } from "@/lib/types";

interface Props {
  meta: ResumeMeta;
  files: FileEntry[];
  system: SystemStatus | null;
  autosave: boolean;
  onAutosave(on: boolean): void;
  onChanged(meta: ResumeMeta): void;
}

function Row({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <div className="min-w-0">
        <p className="text-sm">{title}</p>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Per-resume compiler settings, editor preferences, and the resume itself (Overleaf's Menu → Settings). */
export function SettingsDialog({ meta, files, system, autosave, onAutosave, onChanged }: Props) {
  const router = useRouter();
  const editor = useEditorSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? meta.name;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmTrust, setConfirmTrust] = useState(false);

  const update = async (patch: Partial<Pick<ResumeMeta, "name" | "engine" | "mainFile" | "trusted" | "haltOnError">>) => {
    try {
      onChanged(await api.update(meta.id, patch));
      if (patch.name) setDraft(null);
    } catch (e) {
      toast.error("Couldn't update the resume", { description: (e as Error).message });
    }
  };
  const saveName = () => name.trim() && name.trim() !== meta.name && void update({ name: name.trim() });
  const texFiles = files.filter((f) => f.kind === "file" && /\.(tex|xtx|ltx)$/.test(f.path));

  return (
    <>
      <Dialog>
        <DialogTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Settings" title="Settings" />}>
          <Settings2 />
        </DialogTrigger>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription className="font-mono text-xs">resumes/{meta.id}/</DialogDescription>
          </DialogHeader>
          <Tabs defaultValue="compiler">
            <TabsList className="w-full">
              <TabsTrigger value="compiler">Compiler</TabsTrigger>
              <TabsTrigger value="editor">Editor</TabsTrigger>
              <TabsTrigger value="resume">Resume</TabsTrigger>
            </TabsList>

            <TabsContent value="compiler" className="divide-y divide-border/60">
              <Row
                title="Compiler"
                hint={meta.engine !== "pdflatex" ? "Chosen for you when the preamble loads fontspec, or by a % !TEX program line." : undefined}
              >
                <Select value={meta.engine} onValueChange={(v) => void update({ engine: v as Engine })}>
                  <SelectTrigger size="sm" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ENGINES.map((e) => (
                      <SelectItem key={e.id} value={e.id} disabled={!!system && !system.tex.engines[e.id]}>
                        <span className="flex flex-col">
                          <span>{e.label}</span>
                          <span className="text-[11px] text-muted-foreground">{e.hint}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
              <Row title="Main document">
                <Select value={meta.mainFile} onValueChange={(v) => void update({ mainFile: String(v) })}>
                  <SelectTrigger size="sm" className="w-40 font-mono text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {texFiles.map((f) => (
                      <SelectItem key={f.path} value={f.path} className="font-mono text-xs">
                        {f.path}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
              <Row title="Auto compile" hint="Save and recompile shortly after you stop typing. Off: ⌘S compiles.">
                <Switch checked={autosave} onCheckedChange={(v) => onAutosave(!!v)} />
              </Row>
              <Row title="Stop on first error" hint="Off (Overleaf's default): TeX carries on past errors, so you see every problem at once.">
                <Switch checked={meta.haltOnError} onCheckedChange={(v) => void update({ haltOnError: !!v })} />
              </Row>
              <Row
                title="Trusted project"
                hint={
                  <>
                    Allows <span className="font-mono">-shell-escape</span> (minted, svg, gnuplot) and the project&apos;s{" "}
                    <span className="font-mono">latexmkrc</span>. Both run commands on this Mac: only for files you trust.
                  </>
                }
              >
                <Switch checked={meta.trusted} onCheckedChange={(v) => (v ? setConfirmTrust(true) : void update({ trusted: false }))} />
              </Row>
              {system?.tex.version && <p className="pt-2.5 text-[11px] text-muted-foreground">{system.tex.version}, latexmk</p>}
            </TabsContent>

            <TabsContent value="editor" className="divide-y divide-border/60">
              <Row title="Font size">
                <Select value={String(editor.fontSize)} onValueChange={(v) => setEditorSettings({ fontSize: Number(v) })}>
                  <SelectTrigger size="sm" className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[11, 12, 13, 14, 15, 16, 18, 20].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n}px
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
              <Row title="Keybindings">
                <Select value={editor.keymap} onValueChange={(v) => setEditorSettings({ keymap: v as KeymapMode })}>
                  <SelectTrigger size="sm" className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default</SelectItem>
                    <SelectItem value="vim">Vim</SelectItem>
                    <SelectItem value="emacs">Emacs</SelectItem>
                  </SelectContent>
                </Select>
              </Row>
              <Row title="Auto-complete" hint="Commands, environments, \ref labels, \cite keys, file names. Ctrl+Space opens it anytime.">
                <Switch checked={editor.autocomplete} onCheckedChange={(v) => setEditorSettings({ autocomplete: !!v })} />
              </Row>
              <Row title="Auto-close brackets and environments" hint="{ → {}, and Enter after \begin{x} adds \end{x}.">
                <Switch checked={editor.autoClose} onCheckedChange={(v) => setEditorSettings({ autoClose: !!v })} />
              </Row>
              <Row title="Wrap long lines">
                <Switch checked={editor.lineWrapping} onCheckedChange={(v) => setEditorSettings({ lineWrapping: !!v })} />
              </Row>
              <Row title="Spell check" hint="Your Mac's spell checker; right-click a word for suggestions.">
                <Switch checked={editor.spellcheck} onCheckedChange={(v) => setEditorSettings({ spellcheck: !!v })} />
              </Row>
            </TabsContent>

            <TabsContent value="resume" className="grid gap-4 pt-2">
              <form
                className="grid gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveName();
                }}
              >
                <label htmlFor="rs-name" className="text-sm">
                  Name
                </label>
                <Input id="rs-name" value={name} onChange={(e) => setDraft(e.target.value)} onBlur={saveName} className="h-8" />
              </form>
              <div className="flex items-center justify-between rounded-lg border border-destructive/30 px-3 py-2.5">
                <div>
                  <p className="text-sm">Delete this resume</p>
                  <p className="text-xs text-muted-foreground">Moves to .resume-studio/trash/; its snapshot history is kept.</p>
                </div>
                <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
                  <Trash2 />
                  Delete
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmTrust} onOpenChange={setConfirmTrust}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-warning" />
              Trust this project?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Its .tex files will be able to run any command on this Mac (\write18 / -shell-escape), and its latexmkrc (Perl code) will run on every build.
              Overleaf does this inside a sandbox; here it runs as you. Only turn this on for files you wrote or trust.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmTrust(false);
                void update({ trusted: true });
              }}
            >
              Trust and rebuild
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{meta.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The folder moves to <span className="font-mono">.resume-studio/trash/</span> and a final snapshot is kept, so it can be recovered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                setConfirmDelete(false);
                try {
                  await api.remove(meta.id);
                  toast.success(`Deleted “${meta.name}”`);
                  router.push("/");
                } catch (e) {
                  toast.error("Couldn't delete", { description: (e as Error).message });
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
