"use client";

import { Check, CircleAlert, Loader2, RotateCcw, Settings2, Square } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Answer } from "@resume-studio/tailor";
import { toast } from "sonner";
import { AiSettingsDialog } from "@/components/ai/ai-settings-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatDuration } from "@/lib/format";
import { jobCompany, jobTitle, tailorApi, type SessionView as Session } from "@/lib/tailor-api";
import { useServerEvents } from "@/lib/use-events";
import { cn } from "@/lib/utils";
import { FitCard } from "./fit-card";
import { Review } from "./review";
import { TailorHeader } from "./tailor-header";

const WORKING = new Set(["created", "analyzing", "writing", "verifying"]);

export function SessionView({ id }: { id: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    try {
      setSession(await tailorApi.get(id));
    } catch (e) {
      if ((e as { status?: number }).status === 404) setMissing(true);
    }
  }, [id]);

  useEffect(() => {
    tailorApi.get(id).then(setSession, (e) => {
      if ((e as { status?: number }).status === 404) setMissing(true);
    });
  }, [id]);

  // Live progress: the server announces every step; refetch (coalesced) when this session moves.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useServerEvents((e) => {
    if (e.type !== "tailor" || e.sessionId !== id || pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      void load();
    }, 250);
  }, load);

  // A fallback while work is in flight, in case an event is missed.
  const working = !!session && !session.interrupted && (WORKING.has(session.status) || session.running);
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [working, load]);

  if (missing) {
    return (
      <div className="flex h-dvh flex-col">
        <TailorHeader crumbs={<span>Tailoring</span>} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          This tailoring session doesn&apos;t exist (anymore).
          <Button variant="outline" nativeButton={false} render={<Link href="/" />}>
            Back to your resumes
          </Button>
        </div>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="flex h-dvh flex-col">
        <TailorHeader crumbs={<span>Tailoring</span>} />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
        </div>
      </div>
    );
  }

  const title = `${jobTitle(session.job)} · ${jobCompany(session.job)}`;
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TailorHeader
        crumbs={
          <>
            <Link href={`/r/${encodeURIComponent(session.context.resumeId)}`} className="max-w-48 truncate text-muted-foreground hover:text-foreground">
              {session.context.resumeName ?? session.context.resumeId}
            </Link>
            <span className="text-muted-foreground/50">/</span>
            <span className="truncate font-medium" title={title}>
              {title}
            </span>
            <StatusPill session={session} />
          </>
        }
      >
        <span className="hidden text-xs text-muted-foreground md:inline" title="Provider and model">
          {session.provenance.provider} · {session.provenance.model}
        </span>
        {working && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void tailorApi
                .cancel(id)
                .then(load)
                .catch((e) => toast.error("Couldn't cancel", { description: (e as Error).message }))
            }
          >
            <Square className="size-3" />
            Cancel
          </Button>
        )}
      </TailorHeader>
      <main className="min-h-0 flex-1">
        {session.status === "ready" ? (
          <Review session={session} />
        ) : session.status === "needs_input" ? (
          <Questions session={session} onDone={load} />
        ) : session.status === "failed" || session.status === "cancelled" || session.interrupted ? (
          <Stopped session={session} onRetry={load} />
        ) : (
          <Progress session={session} />
        )}
      </main>
    </div>
  );
}

function StatusPill({ session }: { session: Session }) {
  const map: Record<string, [string, string]> = {
    created: ["Starting", "bg-muted text-muted-foreground"],
    analyzing: ["Analyzing", "bg-primary/15 text-primary"],
    needs_input: ["Needs your input", "bg-warning/15 text-warning"],
    writing: ["Writing", "bg-primary/15 text-primary"],
    verifying: ["Checking", "bg-primary/15 text-primary"],
    ready: ["Ready to review", "bg-success/15 text-success"],
    failed: ["Failed", "bg-destructive/15 text-destructive"],
    cancelled: ["Cancelled", "bg-muted text-muted-foreground"],
  };
  const [label, cls] = session.interrupted ? ["Interrupted", "bg-warning/15 text-warning"] : (map[session.status] ?? [session.status, "bg-muted"]);
  return <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium", cls)}>{label}</span>;
}

// ---- Working ------------------------------------------------------------------------------------------------

const PHASES = [
  { key: "read", label: "Read the job", detail: "Requirements, must-have keywords, level, deal-breakers" },
  { key: "match", label: "Match your experience", detail: "Each requirement against your bullets and your saved facts" },
  { key: "write", label: "Write the changes", detail: "Rewrites in the job's language, ordered by relevance" },
  { key: "check", label: "Fact-check and build", detail: "Every claim traced to your resume; compiled and fitted to the page" },
];

function phaseOf(s: Session): number {
  if (s.status === "verifying") return 3;
  if (s.status === "writing") return 2;
  if (s.matches) return 2;
  if (s.profile) return 1;
  return 0;
}

function Progress({ session }: { session: Session }) {
  const phase = phaseOf(session);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const started = Date.parse(session.createdAt);
  const lastStep = [...session.events].reverse().find((e) => e.type === "step");
  const warnings = session.events.filter((e) => e.type === "warning");

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid max-w-5xl gap-8 px-6 py-10 lg:grid-cols-[22rem_1fr]">
        <section>
          <h2 className="text-lg font-semibold">Tailoring your resume</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Usually 1–3 minutes. You can leave this page; it keeps running and shows up on your resumes page.
          </p>
          <ol className="mt-6 space-y-1">
            {PHASES.map((p, i) => (
              <li key={p.key} className="flex gap-3 rounded-lg px-2 py-2.5">
                <span
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]",
                    i < phase && "border-success bg-success/15 text-success",
                    i === phase && "border-primary text-primary",
                    i > phase && "text-muted-foreground",
                  )}
                >
                  {i < phase ? <Check className="size-3" /> : i === phase ? <Loader2 className="size-3 animate-spin" /> : i + 1}
                </span>
                <span>
                  <span className={cn("block text-sm font-medium", i > phase && "text-muted-foreground")}>{p.label}</span>
                  <span className="block text-xs text-muted-foreground">{i === phase && lastStep ? lastStep.message : p.detail}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-4 px-2 text-xs text-muted-foreground tabular-nums">
            {formatDuration(Math.max(0, now - started))} elapsed · {session.usage.calls} model call{session.usage.calls === 1 ? "" : "s"}
          </p>
          {warnings.length > 0 && (
            <ul className="mt-4 space-y-1 px-2 text-xs text-warning">
              {warnings.map((w, i) => (
                <li key={i}>{w.message}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="min-w-0 space-y-4">
          {session.fit && <FitCard fit={session.fit} />}
          {session.profile ? (
            <div className="rounded-xl border bg-card p-5">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">What this role needs</p>
              <p className="mt-2 text-sm leading-relaxed">{session.profile.summary}</p>
              <ul className="mt-4 space-y-1.5">
                {session.profile.requirements.map((r) => {
                  const m = session.matches?.find((x) => x.requirementId === r.id);
                  return (
                    <li key={r.id} className="flex items-start gap-2 text-sm">
                      <MatchDot status={m?.status} />
                      <span className="min-w-0 flex-1">
                        {r.text}
                        {r.kind === "nice" && <span className="ml-1.5 text-[11px] text-muted-foreground">nice to have</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <div className="space-y-3 rounded-xl border bg-card p-5">
              {[80, 95, 70, 88, 60].map((w, i) => (
                <div key={i} className="h-3 animate-pulse rounded bg-muted" style={{ width: `${w}%` }} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export function MatchDot({ status }: { status?: "strong" | "weak" | "missing" }) {
  const cls =
    status === "strong" ? "bg-success" : status === "weak" ? "bg-warning" : status === "missing" ? "bg-destructive" : "bg-muted-foreground/40 animate-pulse";
  const label = status === "strong" ? "Clearly shown" : status === "weak" ? "Partly shown" : status === "missing" ? "Not shown" : "Checking";
  return <span role="img" title={label} aria-label={label} className={cn("mt-1.5 size-2 shrink-0 rounded-full", cls)} />;
}

// ---- Questions ----------------------------------------------------------------------------------------------

function Questions({ session, onDone }: { session: Session; onDone(): void }) {
  const questions = session.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, { text: string; none: boolean }>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, { text: "", none: false }])),
  );
  const [busy, setBusy] = useState(false);
  const requirement = (rid: string) => session.profile?.requirements.find((r) => r.id === rid);

  const send = async (skip: boolean) => {
    setBusy(true);
    try {
      await tailorApi.answer(
        session.id,
        skip
          ? []
          : // A blank answer is skipped, not "haven't done this": that one is remembered for good.
            questions.flatMap((q): Answer[] =>
              answers[q.id].none
                ? [{ questionId: q.id, none: true }]
                : answers[q.id].text.trim()
                  ? [{ questionId: q.id, text: answers[q.id].text.trim() }]
                  : [],
            ),
      );
      onDone();
    } catch (e) {
      toast.error("Couldn't send your answers", { description: (e as Error).message });
      setBusy(false);
    }
  };

  const answered = questions.filter((q) => answers[q.id].none || answers[q.id].text.trim()).length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        {session.fit && <FitCard fit={session.fit} className="mb-6" />}
        <h2 className="text-lg font-semibold">A few requirements aren&apos;t clearly shown on your resume yet</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          If you&apos;ve done any of these, say where and what, briefly. Answers are only used as written, and are saved to your profile so you won&apos;t be
          asked again. If you haven&apos;t, tick &quot;I haven&apos;t done this&quot;: nothing will be claimed, and it won&apos;t be asked again. Leave one
          blank to skip it for now.
        </p>
        <ol className="mt-6 space-y-4">
          {questions.map((q, i) => {
            const a = answers[q.id];
            const r = requirement(q.requirementId);
            return (
              <li key={q.id} className="rounded-xl border bg-card p-4">
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-primary/15 px-1.5 py-0.5 text-[11px] font-medium text-primary">{q.topic}</span>
                  {r && <span className="truncate text-xs text-muted-foreground">{r.text}</span>}
                </div>
                <p className="mt-2 text-sm font-medium">
                  {i + 1}. {q.question}
                </p>
                <Textarea
                  className="mt-3 min-h-20 text-sm"
                  disabled={a.none}
                  placeholder="e.g. At Foo I moved our 3 services to Kubernetes (EKS) and wrote the Helm charts."
                  value={a.text}
                  onChange={(e) => setAnswers((s) => ({ ...s, [q.id]: { ...s[q.id], text: e.target.value } }))}
                />
                <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground select-none">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-[var(--primary)]"
                    checked={a.none}
                    onChange={(e) => setAnswers((s) => ({ ...s, [q.id]: { ...s[q.id], none: e.target.checked } }))}
                  />
                  I haven&apos;t done this
                </label>
              </li>
            );
          })}
        </ol>
        <div className="sticky bottom-0 mt-6 flex items-center gap-2 border-t bg-background/90 py-4 backdrop-blur">
          <span className="text-xs text-muted-foreground">
            {answered} of {questions.length} answered. Blank ones are skipped for now.
          </span>
          <Button variant="ghost" className="ml-auto" disabled={busy} onClick={() => void send(true)}>
            Skip questions
          </Button>
          <Button disabled={busy} onClick={() => void send(false)}>
            {busy && <Loader2 className="animate-spin" />}
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- Failed / cancelled -------------------------------------------------------------------------------------

function Stopped({ session, onRetry }: { session: Session; onRetry(): void }) {
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);
  const failed = session.status === "failed";
  const interrupted = session.interrupted;
  const auth = session.error?.kind === "auth" || session.error?.kind === "config";
  const cancel = async () => {
    setBusy(true);
    try {
      await tailorApi.cancel(session.id);
      onRetry();
    } catch (e) {
      toast.error("Couldn't cancel", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    setBusy(true);
    try {
      await tailorApi.retry(session.id);
      onRetry();
    } catch (e) {
      toast.error("Couldn't retry", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-lg rounded-xl border bg-card p-6">
        <div className="flex items-start gap-3">
          <CircleAlert className={cn("mt-0.5 size-5 shrink-0", failed ? "text-destructive" : interrupted ? "text-warning" : "text-muted-foreground")} />
          <div className="min-w-0">
            <h2 className="font-semibold">
              {interrupted ? "Tailoring was interrupted" : failed ? "Tailoring stopped with an error" : "Tailoring was cancelled"}
            </h2>
            {interrupted ? (
              <p className="mt-1 text-sm text-muted-foreground">Resume Studio was restarted while this was running.</p>
            ) : (
              failed && session.error && <p className="mt-1 text-sm break-words text-muted-foreground">{session.error.message}</p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              {interrupted ? "Resuming" : "Retrying"} keeps the finished steps, so it doesn&apos;t start over.
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          {interrupted && (
            <Button variant="ghost" disabled={busy} onClick={() => void cancel()}>
              Discard
            </Button>
          )}
          {(auth || failed) && (
            <Button variant="outline" onClick={() => setSettings(true)}>
              <Settings2 />
              Check provider
            </Button>
          )}
          <Button disabled={busy} onClick={() => void retry()}>
            {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            {interrupted ? "Resume" : "Retry"}
          </Button>
        </div>
      </div>
      <AiSettingsDialog open={settings} onOpenChange={setSettings} initialProvider={session.provenance.provider as never} />
    </div>
  );
}
