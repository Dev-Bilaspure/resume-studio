"use client";

import { Check, ChevronRight, CircleAlert, CircleX, Copy, FileText, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AtsCategory, AtsCheck, AtsReport } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  report: AtsReport | null;
  /** True when the shown report belongs to an older build than the latest (the latest failed). */
  stale: boolean;
  onJump(file: string, line: number): void;
}

const CATEGORIES: { id: AtsCategory; title: string; blurb: string }[] = [
  { id: "parsing", title: "Machine readability", blurb: "Can an ATS turn the PDF into correct text?" },
  { id: "structure", title: "Sections & contact", blurb: "Can it find who you are and what you did?" },
  { id: "formatting", title: "Layout", blurb: "Features ATS parsers commonly mangle." },
  { id: "content", title: "Content", blurb: "Advice for the human reader. Not scored." },
];

function scoreTone(score: number) {
  return score >= 90 ? "text-success" : score >= 70 ? "text-warning" : "text-destructive";
}

function StatusIcon({ status }: { status: AtsCheck["status"] }) {
  if (status === "pass") return <Check className="size-3.5 shrink-0 text-success" />;
  if (status === "warn") return <CircleAlert className="size-3.5 shrink-0 text-warning" />;
  return <CircleX className="size-3.5 shrink-0 text-destructive" />;
}

function ScoreRing({ score }: { score: number }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative size-[76px] shrink-0">
      <svg viewBox="0 0 76 76" className="size-full -rotate-90" aria-hidden="true">
        <circle cx="38" cy="38" r={r} fill="none" stroke="var(--muted)" strokeWidth="6" />
        <circle
          cx="38"
          cy="38"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - score / 100)}
          className={cn("transition-[stroke-dashoffset] duration-700", scoreTone(score))}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn("text-xl font-semibold tabular-nums", scoreTone(score))}>{score}</span>
        <span className="-mt-0.5 text-[10px] text-muted-foreground">/ 100</span>
      </div>
    </div>
  );
}

function CheckRow({ check, onJump }: { check: AtsCheck; onJump: Props["onJump"] }) {
  const [open, setOpen] = useState(check.status !== "pass");
  const expandable = check.status !== "pass" && (check.fix || check.file);
  return (
    <li className="px-3">
      <button
        type="button"
        onClick={() => expandable && setOpen((o) => !o)}
        className={cn("flex w-full items-start gap-2 py-2 text-left", expandable && "cursor-pointer")}
      >
        <span className="mt-0.5">
          <StatusIcon status={check.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] text-foreground">{check.title}</span>
          <span className="block text-xs leading-relaxed text-muted-foreground">{check.detail}</span>
        </span>
        {expandable && <ChevronRight className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />}
      </button>
      {expandable && open && (
        <div className="mb-2 ml-5.5 rounded-md border bg-muted/40 px-2.5 py-2 text-xs leading-relaxed">
          {check.fix && <p className="font-mono text-[11.5px] whitespace-pre-wrap text-foreground/90">{check.fix}</p>}
          {check.file && check.line && (
            <Button variant="link" size="xs" className="mt-1 h-auto px-0 text-xs" onClick={() => onJump(check.file!, check.line!)}>
              Go to {check.file}:{check.line}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** What an ATS gets out of the PDF, with a quick keyword finder. */
function ExtractedText({ text }: { text: string }) {
  const [q, setQ] = useState("");
  const hits = useMemo(() => {
    const term = q.trim();
    if (!term) return null;
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return (text.match(re) ?? []).length;
  }, [q, text]);
  const parts = useMemo(() => {
    const term = q.trim();
    if (!term) return [text];
    const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    return text.split(re);
  }, [q, text]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Check a keyword, e.g. Kubernetes" className="h-7 pl-7 text-xs" />
        </div>
        {hits !== null && (
          <span className={cn("shrink-0 text-xs tabular-nums", hits ? "text-success" : "text-destructive")}>
            {hits ? `${hits} match${hits === 1 ? "" : "es"}` : "Not found"}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Copy text"
          title="Copy extracted text"
          onClick={() => {
            void navigator.clipboard.writeText(text);
            toast.success("Extracted text copied");
          }}
        >
          <Copy />
        </Button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-foreground/85">
        {parts.map((p, i) =>
          i % 2 === 1 ? (
            <mark key={i} className="rounded-sm bg-warning/30 text-foreground">
              {p}
            </mark>
          ) : (
            p
          ),
        )}
      </pre>
    </div>
  );
}

export function AtsPanel({ report, stale, onJump }: Props) {
  const [view, setView] = useState<"checks" | "text">("checks");

  if (!report) {
    return <div className="p-6 text-center text-sm text-muted-foreground">The ATS check runs after the resume compiles successfully.</div>;
  }
  if (report.unavailable) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">ATS checks need poppler</p>
        <p className="mt-1">{report.unavailable}</p>
      </div>
    );
  }

  const counts = {
    pass: report.checks.filter((c) => c.status === "pass").length,
    warn: report.checks.filter((c) => c.status === "warn").length,
    fail: report.checks.filter((c) => c.status === "fail").length,
  };
  const verdict = report.score >= 90 ? "ATS-ready" : report.score >= 70 ? "Readable, with issues" : "Likely to be misread";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-4 border-b px-4 py-3">
        <ScoreRing score={report.score} />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{verdict}</p>
          <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            {counts.pass} passed · {counts.warn} warning{counts.warn === 1 ? "" : "s"} · {counts.fail} failed
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            {report.stats.pages} page{report.stats.pages === 1 ? "" : "s"} · {report.stats.words} words · {report.stats.fonts.length} fonts ·{" "}
            {report.stats.fileSizeKB} KB
          </p>
          {stale && <p className="mt-1 text-xs text-warning">From the last successful build: the latest one failed.</p>}
        </div>
      </div>
      <div className="flex shrink-0 gap-1 border-b px-2 py-1.5 text-xs">
        <button
          type="button"
          onClick={() => setView("checks")}
          className={cn("rounded-md px-2 py-1 font-medium text-muted-foreground hover:text-foreground", view === "checks" && "bg-muted text-foreground")}
        >
          Checks
        </button>
        <button
          type="button"
          onClick={() => setView("text")}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-muted-foreground hover:text-foreground",
            view === "text" && "bg-muted text-foreground",
          )}
        >
          <FileText className="size-3.5" />
          What the ATS reads
        </button>
      </div>
      {view === "text" ? (
        <ExtractedText text={report.text} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto pb-6">
          {CATEGORIES.map((cat) => {
            const checks = report.checks
              .filter((c) => c.category === cat.id)
              .sort((a, b) => ({ fail: 0, warn: 1, pass: 2 })[a.status] - { fail: 0, warn: 1, pass: 2 }[b.status]);
            if (!checks.length) return null;
            return (
              <section key={cat.id} className="pt-3">
                <div className="px-3 pb-1">
                  <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{cat.title}</h3>
                  <p className="text-[11px] text-muted-foreground/80">{cat.blurb}</p>
                </div>
                <ul className="divide-y divide-border/50">
                  {checks.map((c) => (
                    <CheckRow key={c.id} check={c} onJump={onJump} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
