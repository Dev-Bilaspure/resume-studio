"use client";

import { Camera, Eye, GitCompare, History, Loader2, MoreHorizontal, RotateCcw, Tag, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import type { SnapshotInfo } from "@/lib/types";
import { useServerEvents } from "@/lib/use-events";
import { cn } from "@/lib/utils";

interface Props {
  resumeId: string;
  previewingSha: string | null;
  onPreview(s: SnapshotInfo | null): void;
  onCompare(s: SnapshotInfo): void;
  /** Saves pending edits before a snapshot or restore, so they're part of it / not lost. */
  beforeAction(): Promise<boolean>;
  onRestored(): void;
}

function dayLabel(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const y = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

export function SnapshotButton({ resumeId, beforeAction }: { resumeId: string; beforeAction(): Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await beforeAction();
      const s = await api.snapshot(resumeId, { message: message.trim() || undefined, label: label.trim() || undefined });
      toast.success(label.trim() ? `Snapshot saved as “${label.trim()}”` : "Snapshot saved", { description: s?.message });
      setOpen(false);
      setMessage("");
      setLabel("");
    } catch (err) {
      toast.error("Couldn't take a snapshot", { description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <Camera />
        Snapshot
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <form onSubmit={submit} className="grid gap-3">
          <div>
            <p className="text-sm font-medium">Save a snapshot</p>
            <p className="text-xs text-muted-foreground">
              A restorable copy of this resume as it is now. Snapshots are also taken automatically while you work.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="snap-msg" className="text-xs">
              Description
            </Label>
            <Input
              id="snap-msg"
              autoFocus
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Tightened summary, added Kafka project"
              className="h-8 text-sm"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="snap-label" className="text-xs">
              Label <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input id="snap-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="sent-to-acme" className="h-8 font-mono text-sm" />
          </div>
          <Button type="submit" size="sm" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            Save snapshot
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function HistoryPanel({ resumeId, previewingSha, onPreview, onCompare, beforeAction, onRestored }: Props) {
  const [snaps, setSnaps] = useState<SnapshotInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<SnapshotInfo | null>(null);
  const [labeling, setLabeling] = useState<SnapshotInfo | null>(null);
  const [labelText, setLabelText] = useState("");
  const [showAuto, setShowAuto] = useState(true);

  const load = useCallback(async () => {
    try {
      setSnaps((await api.snapshots(resumeId)).snapshots);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [resumeId]);

  useEffect(() => {
    let cancelled = false;
    api.snapshots(resumeId).then(
      (d) => !cancelled && setSnaps(d.snapshots),
      (e) => !cancelled && setError((e as Error).message),
    );
    return () => {
      cancelled = true;
    };
  }, [resumeId]);

  useServerEvents((e) => {
    if (e.type === "snapshots" && e.resumeId === resumeId) void load();
  });

  const groups = useMemo(() => {
    const list = (snaps ?? []).filter((s) => showAuto || !s.auto || s.labels.length);
    const out: { day: string; items: SnapshotInfo[] }[] = [];
    for (const s of list) {
      const day = dayLabel(s.createdAt);
      const g = out.at(-1);
      if (g?.day === day) g.items.push(s);
      else out.push({ day, items: [s] });
    }
    return out;
  }, [snaps, showAuto]);

  const restore = async () => {
    if (!restoring) return;
    const s = restoring;
    setRestoring(null);
    try {
      await beforeAction();
      await api.restoreSnapshot(resumeId, s.sha);
      onPreview(null);
      onRestored();
      toast.success("Restored", { description: `Your previous version was saved as a snapshot first, so this can be undone.` });
    } catch (e) {
      toast.error("Restore failed", { description: (e as Error).message });
    }
  };

  const addLabel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!labeling || !labelText.trim()) return;
    try {
      await api.labelSnapshot(resumeId, labeling.sha, labelText.trim());
      setLabeling(null);
      setLabelText("");
    } catch (err) {
      toast.error("Couldn't add the label", { description: (err as Error).message });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <History className="size-4 text-muted-foreground" />
        <p className="text-sm font-medium">History</p>
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none">
          <input type="checkbox" checked={showAuto} onChange={(e) => setShowAuto(e.target.checked)} className="accent-[var(--primary)]" />
          Automatic snapshots
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-6">
        {error && <p className="p-3 text-xs text-destructive">{error}</p>}
        {snaps === null && !error && <p className="p-3 text-xs text-muted-foreground">Loading…</p>}
        {snaps?.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground">No snapshots yet</p>
            <p className="mt-1 text-xs">
              One is taken automatically after a successful build, then every few minutes while you edit. Use Snapshot to save a named version, e.g. before
              tailoring it for a job.
            </p>
          </div>
        )}
        {groups.map((g) => (
          <section key={g.day}>
            <h3 className="sticky top-0 z-10 bg-background/95 px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase backdrop-blur">
              {g.day}
            </h3>
            <ul>
              {g.items.map((s, i) => {
                const latest = snaps?.[0]?.sha === s.sha;
                return (
                  <li
                    key={s.sha}
                    className={cn(
                      "group relative mx-1.5 flex items-start gap-2.5 rounded-md px-2 py-2 hover:bg-muted/50",
                      previewingSha === s.sha && "bg-primary/10 ring-1 ring-primary/30 hover:bg-primary/10",
                    )}
                  >
                    <span className="relative mt-1.5 flex flex-col items-center">
                      <span className={cn("size-2 rounded-full", s.labels.length ? "bg-primary" : s.auto ? "bg-muted-foreground/40" : "bg-foreground/70")} />
                      {i < g.items.length - 1 && <span className="absolute top-3 h-[calc(100%+0.75rem)] w-px bg-border" />}
                    </span>
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onPreview(previewingSha === s.sha ? null : s)}>
                      <span className="flex items-center gap-1.5">
                        <span className={cn("truncate text-[13px]", s.auto ? "text-muted-foreground" : "text-foreground")}>{s.message}</span>
                        {latest && <span className="shrink-0 text-[10px] text-muted-foreground">latest</span>}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
                        <span title={new Date(s.createdAt).toLocaleString()}>{relativeTime(s.createdAt)}</span>
                        {(s.insertions > 0 || s.deletions > 0) && (
                          <span>
                            <span className="text-success">+{s.insertions}</span> <span className="text-destructive">−{s.deletions}</span>
                          </span>
                        )}
                        {s.labels.map((l) => (
                          <Badge key={l} variant="secondary" className="h-4 gap-0.5 px-1.5 font-mono text-[10px]">
                            <Tag className="size-2.5!" />
                            {l}
                            <span
                              role="button"
                              tabIndex={0}
                              aria-label={`Remove label ${l}`}
                              className="ml-0.5 hidden opacity-60 group-hover:inline hover:opacity-100"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                void api.removeLabel(resumeId, l).catch((err) => toast.error((err as Error).message));
                              }}
                            >
                              <X className="size-2.5!" />
                            </span>
                          </Badge>
                        ))}
                      </span>
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Snapshot actions"
                            className="opacity-0 group-hover:opacity-100 aria-expanded:opacity-100"
                          />
                        }
                      >
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem onClick={() => onPreview(s)}>
                          <Eye />
                          View PDF
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onCompare(s)}>
                          <GitCompare />
                          Compare with current
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => {
                            setLabeling(s);
                            setLabelText("");
                          }}
                        >
                          <Tag />
                          Add label…
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem disabled={latest} onClick={() => setRestoring(s)}>
                          <RotateCcw />
                          Restore this version
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <AlertDialog open={!!restoring} onOpenChange={(o) => !o && setRestoring(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this version?</AlertDialogTitle>
            <AlertDialogDescription>
              The resume&apos;s files go back to “{restoring?.message}” ({restoring && new Date(restoring.createdAt).toLocaleString()}). Your current version is
              saved as a snapshot first, so you can switch back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={restore}>Restore</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!labeling} onOpenChange={(o) => !o && setLabeling(null)}>
        <AlertDialogContent>
          <form onSubmit={addLabel} className="grid gap-4">
            <AlertDialogHeader>
              <AlertDialogTitle>Label this snapshot</AlertDialogTitle>
              <AlertDialogDescription>A short name to find it again, e.g. the company you sent it to.</AlertDialogDescription>
            </AlertDialogHeader>
            <Input autoFocus value={labelText} onChange={(e) => setLabelText(e.target.value)} placeholder="sent-to-acme" className="font-mono" />
            <AlertDialogFooter>
              <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
              <Button type="submit" disabled={!labelText.trim()}>
                Add label
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
