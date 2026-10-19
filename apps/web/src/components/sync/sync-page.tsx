"use client";

import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, CircleAlert, CloudOff, ExternalLink, Loader2, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { TailorHeader } from "@/components/tailor/tailor-header";
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
import { Input } from "@/components/ui/input";
import { relativeTime } from "@/lib/format";
import { syncApi } from "@/lib/sync-api";
import type { SyncChange, SyncConflict, SyncDiff, SyncItem, SyncStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

type Busy = null | "loading" | "checking" | "connecting" | "uploading" | "downloading" | "disconnecting";

/** Backup & sync: what's here and not in your repository, what's there and not here, and the two buttons. */
export function SyncPage() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState<Busy>("loading");
  const [choices, setChoices] = useState<Record<string, "local" | "remote">>({});

  const act = useCallback(async (kind: Exclude<Busy, null>, fn: () => Promise<SyncStatus>, done?: (s: SyncStatus) => string | null) => {
    setBusy(kind);
    try {
      const s = await fn();
      setStatus(s);
      const msg = done?.(s);
      if (msg) toast.success(msg);
      return s;
    } catch (e) {
      toast.error((e as Error).message);
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  // Show what's known right away, then ask the repository what's new.
  useEffect(() => {
    void (async () => {
      const s = await act("loading", () => syncApi.status());
      if (s?.connected) await act("checking", () => syncApi.status(true));
    })();
  }, [act]);

  return (
    <div className="min-h-dvh bg-[radial-gradient(60rem_26rem_at_50%_-10rem,var(--glow),transparent_70%)] bg-no-repeat">
      <TailorHeader crumbs={<span className="font-medium">Backup &amp; sync</span>} />
      <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-2xl font-semibold">Backup &amp; sync</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Keep your resumes, facts and tailoring history in a private repository you own. Upload what changed here; download it on another computer, or
            on this one after losing the folder.
          </p>
        </div>

        {status === null ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
          </div>
        ) : !status.connected ? (
          <Connect busy={busy === "connecting"} onConnect={(url) => act("connecting", () => syncApi.connect(url), () => "Connected")} />
        ) : (
          <Connected
            status={status}
            busy={busy}
            choices={choices}
            onChoose={(path, side) => setChoices((c) => ({ ...c, [path]: side }))}
            onCheck={() => act("checking", () => syncApi.status(true))}
            onUpload={() =>
              act("uploading", syncApi.upload, () => {
                const n = status.local.length;
                return `Uploaded ${n} change${n === 1 ? "" : "s"}`;
              })
            }
            onDownload={() =>
              act(
                "downloading",
                () => syncApi.download(choices),
                () => {
                  setChoices({});
                  const n = status.remote.length + status.conflicts.length;
                  return `Downloaded ${n} change${n === 1 ? "" : "s"}`;
                },
              )
            }
            onDisconnect={() => act("disconnecting", syncApi.disconnect, () => "Disconnected. Your files are unchanged.")}
          />
        )}

        <WhatIsSynced />
      </main>
    </div>
  );
}

// ---- Not connected -----------------------------------------------------------------------------------------------

function Connect({ busy, onConnect }: { busy: boolean; onConnect(url: string): void }) {
  const [url, setUrl] = useState("");
  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="font-medium">Connect a private repository</h2>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>
          Create an empty <span className="text-foreground">private</span> repository on GitHub, only for this (don&apos;t edit it by hand).
        </li>
        <li>
          Paste its address below. Your git login on this computer is used: if <code className="rounded bg-muted px-1 font-mono text-xs">git push</code> works
          for you in a terminal, this works.
        </li>
        <li>On a new computer, or after losing this folder: connect the same repository, then Download.</li>
      </ol>
      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) onConnect(url.trim());
        }}
      >
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/you/resume-studio-data" aria-label="Repository address" className="flex-1" />
        <Button type="submit" disabled={busy || !url.trim()}>
          {busy && <Loader2 className="animate-spin" />}
          Connect
        </Button>
      </form>
      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="size-3.5 text-success" /> A public repository is refused: your resumes and answers stay private.
      </p>
    </section>
  );
}

// ---- Connected ---------------------------------------------------------------------------------------------------

function Connected({
  status,
  busy,
  choices,
  onChoose,
  onCheck,
  onUpload,
  onDownload,
  onDisconnect,
}: {
  status: SyncStatus;
  busy: Busy;
  choices: Record<string, "local" | "remote">;
  onChoose(path: string, side: "local" | "remote"): void;
  onCheck(): void;
  onUpload(): void;
  onDownload(): void;
  onDisconnect(): void;
}) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const working = busy !== null;
  const incoming = status.remote.length + status.conflicts.length;
  const unchosen = status.conflicts.filter((c) => !choices[c.path]).length;
  const checkFailed = status.lastCheck?.error;
  const inSync = !status.local.length && !incoming && !checkFailed && !status.remoteProblem && !!status.lastCheck;
  const uploadBlocked =
    status.blocked ?? (incoming ? "Download the repository's changes first, so nothing there is overwritten." : status.remoteProblem ? status.remoteProblem : null);
  const downloadBlocked = status.blocked ?? status.remoteProblem ?? (unchosen ? `Choose a version for ${unchosen} file${unchosen === 1 ? "" : "s"} changed in both places.` : null);

  return (
    <>
      <section className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">Repository</p>
          {status.webUrl ? (
            <a href={status.webUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 truncate text-sm font-medium hover:underline">
              {status.webUrl.replace("https://github.com/", "")} <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
            </a>
          ) : (
            <p className="truncate text-sm font-medium">{status.url}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {[
              status.lastUpload ? `Uploaded ${relativeTime(Date.parse(status.lastUpload.at))}` : "Never uploaded from here",
              status.lastDownload ? `downloaded ${relativeTime(Date.parse(status.lastDownload.at))}` : null,
              status.lastCheck ? `checked ${relativeTime(Date.parse(status.lastCheck.at))}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={working} onClick={onCheck}>
          <RefreshCw className={cn(busy === "checking" && "animate-spin")} />
          {busy === "checking" ? "Checking…" : "Check the repository"}
        </Button>
        <Button variant="ghost" size="sm" disabled={working} onClick={() => setConfirmDisconnect(true)} title="Disconnect this computer">
          <Unplug />
          Disconnect
        </Button>
      </section>

      {status.blocked && <Banner tone="info">{status.blocked}</Banner>}
      {checkFailed && (
        <Banner tone="warning" icon={<CloudOff className="mt-0.5 size-4 shrink-0 text-warning" />}>
          Couldn&apos;t check the repository: {checkFailed} The lists below may be out of date.
        </Banner>
      )}
      {status.remoteProblem && <Banner tone="warning">{status.remoteProblem}</Banner>}

      {inSync ? (
        <section className="flex items-center gap-3 rounded-xl border bg-card px-5 py-6">
          <span className="flex size-9 items-center justify-center rounded-full bg-success/15">
            <Check className="size-4 text-success" />
          </span>
          <div>
            <p className="font-medium">Everything is in sync</p>
            <p className="text-sm text-muted-foreground">
              {status.everSynced ? "This computer and the repository have the same data." : "Nothing to upload or download."}
            </p>
          </div>
        </section>
      ) : (
        <>
          {status.conflicts.length > 0 && <Conflicts conflicts={status.conflicts} choices={choices} onChoose={onChoose} disabled={working} />}

          <ChangeList
            title="On this computer, not uploaded"
            empty="Nothing new here."
            items={status.local}
            side="local"
            action={
              <ActionButton icon={<ArrowUpFromLine />} busy={busy === "uploading"} disabled={working || !status.local.length || !!uploadBlocked} onClick={onUpload}>
                Upload {status.local.length || ""} change{status.local.length === 1 ? "" : "s"}
              </ActionButton>
            }
            note={status.local.length ? uploadBlocked : null}
          />

          <ChangeList
            title="In the repository, not on this computer"
            empty={status.lastCheck ? "Nothing new in the repository." : "Check the repository to see what's new there."}
            items={status.remote}
            side="remote"
            action={
              <ActionButton icon={<ArrowDownToLine />} busy={busy === "downloading"} disabled={working || !incoming || !!downloadBlocked} onClick={onDownload}>
                Download {incoming || ""} change{incoming === 1 ? "" : "s"}
              </ActionButton>
            }
            note={
              incoming
                ? (downloadBlocked ??
                  (status.conflicts.length
                    ? `Includes the ${status.conflicts.length === 1 ? "file" : `${status.conflicts.length} files`} changed in both places, above, as you chose.`
                    : null))
                : null
            }
          />
        </>
      )}

      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect this computer?</AlertDialogTitle>
            <AlertDialogDescription>
              Your files here and the repository stay as they are. {status.local.length ? `${status.local.length} change${status.local.length === 1 ? " isn't" : "s aren't"} uploaded yet. ` : ""}
              You can connect again any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmDisconnect(false);
                onDisconnect();
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function Banner({ tone, icon, children }: { tone: "info" | "warning"; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={cn("flex items-start gap-2 rounded-lg border px-4 py-3 text-sm", tone === "warning" ? "border-warning/30 bg-warning/10" : "text-muted-foreground")}>
      {icon ?? <CircleAlert className={cn("mt-0.5 size-4 shrink-0", tone === "warning" && "text-warning")} />}
      <p>{children}</p>
    </div>
  );
}

function ActionButton({ icon, busy, disabled, onClick, children }: { icon: React.ReactNode; busy: boolean; disabled: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <Button size="sm" disabled={disabled} onClick={onClick}>
      {busy ? <Loader2 className="animate-spin" /> : icon}
      {children}
    </Button>
  );
}

// ---- Lists of changes -----------------------------------------------------------------------------------------

const CHANGE: Record<SyncChange, { label: string; cls: string }> = {
  added: { label: "New", cls: "bg-success/15 text-success" },
  modified: { label: "Changed", cls: "bg-primary/15 text-primary" },
  deleted: { label: "Deleted", cls: "bg-destructive/15 text-destructive" },
};

/** Items grouped by what they belong to: a resume, your facts, a tailoring session. */
function groupItems<T extends { group: string; groupLabel: string }>(items: T[]): [string, T[]][] {
  const out = new Map<string, T[]>();
  for (const i of items) out.set(`${i.group}:${i.groupLabel}`, [...(out.get(`${i.group}:${i.groupLabel}`) ?? []), i]);
  return [...out.entries()];
}

function ChangeList({
  title,
  empty,
  items,
  side,
  action,
  note,
}: {
  title: string;
  empty: string;
  items: SyncItem[];
  side: "local" | "remote";
  action: React.ReactNode;
  note: string | null;
}) {
  const groups = useMemo(() => groupItems(items), [items]);
  return (
    <section className="rounded-xl border bg-card">
      <header className="flex flex-wrap items-center gap-3 border-b px-5 py-3">
        <h2 className="text-sm font-medium">
          {title} <span className="text-muted-foreground tabular-nums">({items.length})</span>
        </h2>
        <div className="ml-auto">{action}</div>
        {note && <p className="w-full text-xs text-muted-foreground">{note}</p>}
      </header>
      {items.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y">
          {groups.map(([key, list]) => (
            <li key={key} className="px-5 py-3">
              <p className="text-sm font-medium">{list[0].groupLabel}</p>
              <ul className="mt-1.5 space-y-1">
                {list.map((i) => (
                  <FileRow key={i.path} path={i.path} label={i.label} chip={CHANGE[i.change]} side={side} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Conflicts({
  conflicts,
  choices,
  onChoose,
  disabled,
}: {
  conflicts: SyncConflict[];
  choices: Record<string, "local" | "remote">;
  onChoose(path: string, side: "local" | "remote"): void;
  disabled: boolean;
}) {
  return (
    <section className="rounded-xl border border-warning/40 bg-card">
      <header className="border-b px-5 py-3">
        <h2 className="text-sm font-medium">
          Changed in both places <span className="text-muted-foreground tabular-nums">({conflicts.length})</span>
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Choose which version to keep, then Download. If you use the repository&apos;s, this computer&apos;s version is saved first, in
          .resume-studio/sync/backups.
        </p>
      </header>
      <ul className="divide-y">
        {conflicts.map((c) => (
          <li key={c.path} className="space-y-2 px-5 py-3">
            <p className="text-sm font-medium">
              {c.groupLabel} <span className="font-normal text-muted-foreground">› {c.label}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Here: {CHANGE[c.localChange].label.toLowerCase()} · In the repository: {CHANGE[c.remoteChange].label.toLowerCase()}
            </p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["local", "Keep this computer's"],
                  ["remote", "Use the repository's"],
                ] as const
              ).map(([side, label]) => (
                <Button key={side} type="button" size="xs" variant={choices[c.path] === side ? "default" : "outline"} disabled={disabled} onClick={() => onChoose(c.path, side)}>
                  {choices[c.path] === side && <Check />}
                  {label}
                </Button>
              ))}
            </div>
            <FileRow path={c.path} label="Compare the two versions" side="conflict" />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One file, with its changes on demand. */
function FileRow({ path, label, chip, side }: { path: string; label: string; chip?: { label: string; cls: string }; side: "local" | "remote" | "conflict" }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<SyncDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || diff) return;
    setLoading(true);
    try {
      setDiff(await syncApi.diff(path, side));
    } catch (e) {
      toast.error("Couldn't show the changes", { description: (e as Error).message });
      setOpen(false);
    } finally {
      setLoading(false);
    }
  };
  return (
    <li className="text-xs">
      <button type="button" onClick={() => void toggle()} className="flex w-full items-center gap-2 text-left hover:text-foreground">
        {chip && <span className={cn("w-14 shrink-0 rounded px-1 py-0.5 text-center text-[10.5px] font-medium", chip.cls)}>{chip.label}</span>}
        <span className={cn("min-w-0 flex-1 truncate font-mono", side === "conflict" ? "font-sans text-primary" : "text-muted-foreground")}>{label}</span>
        {loading ? <Loader2 className="size-3 animate-spin" /> : <ChevronDown className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />}
      </button>
      {open && diff && <DiffView diff={diff} />}
    </li>
  );
}

function DiffView({ diff }: { diff: SyncDiff }) {
  if (diff.binary) return <p className="mt-1.5 rounded-md bg-muted px-3 py-2 text-muted-foreground">A binary file (an image or PDF): no text changes to show.</p>;
  if (!diff.text.trim()) return <p className="mt-1.5 rounded-md bg-muted px-3 py-2 text-muted-foreground">No differences in the text.</p>;
  return (
    <pre className="mt-1.5 max-h-96 overflow-auto rounded-md border bg-muted/40 py-2 font-mono text-[11px] leading-relaxed">
      {diff.text.split("\n").map((line, i) => (
        <div
          key={i}
          className={cn(
            "px-3 whitespace-pre-wrap",
            line.startsWith("+") && !line.startsWith("+++") && "bg-success/10 text-success",
            line.startsWith("-") && !line.startsWith("---") && "bg-destructive/10 text-destructive",
            line.startsWith("@@") && "text-muted-foreground",
            (line.startsWith("+++") || line.startsWith("---")) && "font-medium text-muted-foreground",
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

// ---- What's in it ---------------------------------------------------------------------------------------------------

function WhatIsSynced() {
  return (
    <section className="grid gap-4 rounded-xl border bg-card p-5 text-sm sm:grid-cols-2">
      <div>
        <p className="font-medium">Synced</p>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted-foreground">
          <li>Your resumes, and the tailored copies with their job postings</li>
          <li>Your facts: answers you gave, and topics you haven&apos;t done</li>
          <li>Tailoring sessions: questions, answers, suggestions, your choices</li>
          <li>Which AI providers and models you use</li>
        </ul>
      </div>
      <div>
        <p className="font-medium">Never synced</p>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted-foreground">
          <li>API keys (they stay on this computer: enter them again on a new one)</li>
          <li>PDFs and build files (rebuilt automatically)</li>
          <li>Snapshot history and the trash</li>
        </ul>
      </div>
    </section>
  );
}
