"use client";

import { Check, Cloud, Copy, FileText, Loader2, MoreHorizontal, Plus, Settings2, Sparkles, TriangleAlert, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AiSettingsDialog } from "@/components/ai/ai-settings-dialog";
import { TexSetupHint } from "@/components/tex-setup-hint";
import { NewResumeDialog } from "@/components/new-resume-dialog";
import { TailoringStrip } from "@/components/tailor/tailoring-strip";
import { PdfThumb } from "@/components/preview/pdf-thumb";
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
import { Skeleton } from "@/components/ui/skeleton";
import { api, type ResumeSummary } from "@/lib/api";
import { syncApi } from "@/lib/sync-api";
import { relativeTime } from "@/lib/format";
import type { ApplicationStatus, SystemStatus } from "@/lib/types";
import { useServerEvents } from "@/lib/use-events";
import { cn } from "@/lib/utils";

const APPLICATION_STATUS: { value: ApplicationStatus; label: string; cls: string }[] = [
  { value: "draft", label: "Not applied yet", cls: "text-muted-foreground" },
  { value: "applied", label: "Applied", cls: "text-primary" },
  { value: "interviewing", label: "Interviewing", cls: "text-warning" },
  { value: "offer", label: "Offer", cls: "text-success" },
  { value: "rejected", label: "Rejected", cls: "text-destructive" },
  { value: "withdrawn", label: "Withdrawn", cls: "text-muted-foreground" },
];

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return null;
  return (
    <span
      title="ATS readiness score"
      className={cn(
        "rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
        score >= 90 ? "bg-success/15 text-success" : score >= 70 ? "bg-warning/15 text-warning" : "bg-destructive/15 text-destructive",
      )}
    >
      ATS {score}
    </span>
  );
}

/** Backup & sync, with how many changes here aren't uploaded yet (from the last sync; no network). */
function SyncButton() {
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => {
    syncApi.status().then(
      (s) => setPending(s.connected ? s.local.length : null),
      () => {},
    );
  }, []);
  return (
    <Button size="sm" variant="ghost" nativeButton={false} render={<Link href="/sync" />} title={pending ? `${pending} change${pending === 1 ? "" : "s"} not uploaded` : "Backup & sync"}>
      <Cloud />
      Sync
      {pending ? <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground tabular-nums">{pending}</span> : null}
    </Button>
  );
}

export function ResumeGallery() {
  const [resumes, setResumes] = useState<ResumeSummary[] | null>(null);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [creating, setCreating] = useState<{ duplicateOf: ResumeSummary | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const [aiSettings, setAiSettings] = useState(false);
  const zipInput = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Overleaf → Menu → Download → Source gives a .zip; it becomes a resume here, main file detected.
  const importZip = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    try {
      const { id } = await api.importZip(file.name.replace(/\.zip$/i, ""), file);
      router.push(`/r/${encodeURIComponent(id)}`);
    } catch (e) {
      toast.error("Couldn't import the archive", { description: (e as Error).message });
    } finally {
      setImporting(false);
      if (zipInput.current) zipInput.current.value = "";
    }
  };

  const setStatus = async (r: ResumeSummary, status: ApplicationStatus) => {
    try {
      const meta = await api.update(r.id, { applicationStatus: status });
      setResumes((list) => list?.map((x) => (x.id === r.id ? { ...x, application: meta.application } : x)) ?? list);
    } catch (e) {
      toast.error("Couldn't update the application", { description: (e as Error).message });
    }
  };

  const load = useCallback(async () => {
    const d = await api.list().catch(() => null);
    if (d) setResumes(d.resumes);
  }, []);

  useEffect(() => {
    api.list().then(
      (d) => setResumes(d.resumes),
      () => setResumes([]),
    );
    api.system().then(setSystem, () => {});
  }, []);

  useServerEvents((e) => {
    if (e.type === "resumes" || e.type === "build") void load();
  }, load);

  return (
    <div className="min-h-full bg-[radial-gradient(60rem_26rem_at_50%_-10rem,var(--glow),transparent_70%)] bg-no-repeat">
      <header className="sticky top-0 z-40 border-b bg-background/75 backdrop-blur-md supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <span className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="size-2.5 rounded-[3px] bg-primary" aria-hidden />
            Resume Studio
          </span>
          <div className="ml-auto flex items-center gap-2">
            <input ref={zipInput} type="file" accept=".zip,application/zip" hidden onChange={(e) => void importZip(e.target.files?.[0])} />
            <Button
              size="sm"
              variant="outline"
              disabled={importing}
              onClick={() => zipInput.current?.click()}
              title="Import a project .zip, e.g. from Overleaf (Menu → Download → Source)"
            >
              {importing ? <Loader2 className="animate-spin" /> : <Upload />}
              Import .zip
            </Button>
            <Button size="sm" variant="outline" onClick={() => setCreating({ duplicateOf: null })}>
              <Plus />
              New resume
            </Button>
            <SyncButton />
            <Button size="sm" variant="ghost" aria-label="AI providers" title="AI providers" onClick={() => setAiSettings(true)}>
              <Settings2 />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        {system && !system.tex.available && (
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              <p className="font-medium">{system.compiler.mode === "service" ? "The compile service isn't running" : "TeX isn't installed"}</p>
              <p className="mt-0.5 text-muted-foreground">
                <TexSetupHint system={system} /> Resumes compile as soon as it&apos;s there.
              </p>
            </div>
          </div>
        )}
        {system && system.tex.available && !system.ats.available && (
          <div className="mb-6 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <p>
              ATS checks need poppler: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">brew install poppler</code>
            </p>
          </div>
        )}

        <TailoringStrip savedSessions={new Set((resumes ?? []).flatMap((r) => (r.application?.session ? [r.application.session] : [])))} />

        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Your resumes</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Stored as plain LaTeX in <span className="font-mono text-xs">{system ? `${system.root}/resumes` : "resumes/"}</span>
            </p>
          </div>
        </div>

        {resumes === null ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="aspect-[8.5/12] rounded-xl" />
            ))}
          </div>
        ) : resumes.length === 0 ? (
          <div className="flex flex-col items-center rounded-xl border border-dashed px-6 py-16 text-center">
            <FileText className="size-8 text-muted-foreground" />
            <p className="mt-3 font-medium">No resumes yet</p>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">Start from an ATS-safe template. Everything stays on this Mac as .tex files you own.</p>
            <div className="mt-5 flex gap-2">
              <Button onClick={() => setCreating({ duplicateOf: null })}>
                <Plus />
                Create your first resume
              </Button>
              <Button variant="outline" onClick={() => zipInput.current?.click()}>
                <Upload />
                Import from Overleaf (.zip)
              </Button>
            </div>
          </div>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-5">
            {resumes.map((r) => (
              <li key={r.id} className="group relative">
                <Link
                  href={`/r/${encodeURIComponent(r.id)}`}
                  className="block rounded-xl border bg-card p-2.5 transition-colors hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <div className="overflow-hidden rounded-md ring-1 ring-black/20">
                    {r.build.pdfUrl ? (
                      <PdfThumb url={r.build.pdfUrl} />
                    ) : (
                      <div className="flex aspect-[8.5/11] items-center justify-center bg-muted text-xs text-muted-foreground">
                        {r.build.status === null ? <Loader2 className="size-4 animate-spin" /> : "No PDF yet"}
                      </div>
                    )}
                  </div>
                  <div className="px-1 pt-2.5 pb-0.5">
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm font-medium">{r.name}</p>
                      <ScoreBadge score={r.build.score} />
                    </div>
                    {r.application && (
                      <p className="mt-1 flex items-center gap-1 truncate text-[11px] text-primary" title={`Tailored for ${r.application.role} at ${r.application.company}`}>
                        <Sparkles className="size-3 shrink-0" />
                        <span className="truncate">
                          {r.application.company} · {r.application.role}
                        </span>
                        {r.application.status !== "draft" && (
                          <span className={cn("ml-auto shrink-0 font-medium", APPLICATION_STATUS.find((x) => x.value === r.application!.status)?.cls)}>
                            {APPLICATION_STATUS.find((x) => x.value === r.application!.status)?.label}
                          </span>
                        )}
                      </p>
                    )}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Edited {relativeTime(Date.parse(r.updatedAt))}
                      {r.build.pages ? ` · ${r.build.pages} page${r.build.pages === 1 ? "" : "s"}` : ""}
                      {r.build.status && r.build.status !== "ok" ? " · build failing" : ""}
                    </p>
                  </div>
                </Link>
                <div className="absolute top-4 right-4 flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-aria-expanded:opacity-100">
                  <Button
                    variant="secondary"
                    size="xs"
                    className="shadow-sm"
                    nativeButton={false}
                    render={<Link href={`/tailor/new?resume=${encodeURIComponent(r.id)}`} />}
                    title={`Tailor “${r.name}” for a job posting`}
                  >
                    <Sparkles />
                    Tailor
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="secondary" size="icon-xs" aria-label="Resume actions" className="shadow-sm" />}>
                      <MoreHorizontal />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-48">
                      <DropdownMenuItem onClick={() => router.push(`/tailor/new?resume=${encodeURIComponent(r.id)}`)}>
                        <Sparkles />
                        Tailor for a job…
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setCreating({ duplicateOf: r })}>
                        <Copy />
                        Duplicate…
                      </DropdownMenuItem>
                      {r.application && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuGroup>
                            <DropdownMenuLabel>Application</DropdownMenuLabel>
                            {APPLICATION_STATUS.map((st) => (
                              <DropdownMenuItem key={st.value} onClick={() => void setStatus(r, st.value)}>
                                <Check className={cn(r.application!.status === st.value ? "opacity-100" : "opacity-0")} />
                                {st.label}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuGroup>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
      <AiSettingsDialog open={aiSettings} onOpenChange={setAiSettings} />
      <NewResumeDialog open={creating !== null} onOpenChange={(o) => !o && setCreating(null)} duplicateOf={creating?.duplicateOf ?? null} />
    </div>
  );
}
