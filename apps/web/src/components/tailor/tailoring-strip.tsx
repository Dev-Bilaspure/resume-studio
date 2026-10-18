"use client";

import { Loader2, Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { relativeTime } from "@/lib/format";
import { jobCompany, jobTitle, tailorApi, type SessionSummary } from "@/lib/tailor-api";
import { useServerEvents } from "@/lib/use-events";
import { FitDot } from "./fit-card";
import { cn } from "@/lib/utils";

const RECENT_MS = 14 * 86_400_000;

const STATE: Record<string, { label: string; cls: string; busy?: boolean }> = {
  created: { label: "Starting", cls: "text-primary", busy: true },
  analyzing: { label: "Analyzing", cls: "text-primary", busy: true },
  writing: { label: "Writing", cls: "text-primary", busy: true },
  verifying: { label: "Checking", cls: "text-primary", busy: true },
  needs_input: { label: "Needs your answers", cls: "text-warning" },
  ready: { label: "Ready to review", cls: "text-success" },
  failed: { label: "Failed", cls: "text-destructive" },
};

/** Recent tailoring runs: the ones in flight, waiting for you, or ready to review. */
export function TailoringStrip({ savedSessions }: { savedSessions: Set<string> }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const load = useCallback(() => {
    tailorApi.list().then(
      (d) => {
        const now = Date.now();
        setSessions(d.sessions.filter((s) => s.status !== "cancelled" && now - Date.parse(s.updatedAt) < RECENT_MS));
      },
      () => {},
    );
  }, []);
  useEffect(load, [load]);
  useServerEvents((e) => {
    if (e.type === "tailor") load();
  }, load);

  // Saved ones last: they're done.
  const shown = [...sessions].sort((a, b) => Number(savedSessions.has(a.id)) - Number(savedSessions.has(b.id))).slice(0, 8);
  if (!shown.length) return null;

  return (
    <section className="mb-8">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <Sparkles className="size-3.5 text-primary" />
        Tailoring
      </h2>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
        {shown.map((s) => {
          const saved = savedSessions.has(s.id);
          const st = saved
            ? { label: "Saved as a resume", cls: "text-muted-foreground" }
            : s.interrupted
              ? { label: "Interrupted", cls: "text-warning" }
              : (STATE[s.status] ?? { label: s.status, cls: "" });
          return (
            <li key={s.id}>
              <Link
                href={`/tailor/${s.id}`}
                className="block rounded-xl border bg-card px-4 py-3 transition-colors hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <p className="truncate text-sm font-medium">{jobCompany(s.job)}</p>
                <p className="truncate text-xs text-muted-foreground">{jobTitle(s.job)}</p>
                {s.fit && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    <FitDot level={s.fit.level} />
                  </p>
                )}
                <p className="mt-2 flex items-center gap-1.5 text-[11px]">
                  {"busy" in st && st.busy && <Loader2 className="size-3 animate-spin text-primary" />}
                  <span className={cn("font-medium", st.cls)}>{st.label}</span>
                  <span className="ml-auto text-muted-foreground">{relativeTime(Date.parse(s.updatedAt))}</span>
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
