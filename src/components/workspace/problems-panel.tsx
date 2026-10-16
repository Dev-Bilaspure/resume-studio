"use client";

import { CircleAlert, CircleX, Download, FileText, Info, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { BuildResult, Diagnostic, OutputFile, Severity } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  resumeId: string;
  result: BuildResult | null;
  onJump(file: string, line: number): void;
}

/** Raw output of the last build: the .log, .blg (biber/bibtex), .aux… (Overleaf's "Logs and output files"). */
function LogsAndFiles({ resumeId, buildId }: { resumeId: string; buildId: number | null }) {
  const [files, setFiles] = useState<OutputFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    api.outputFiles(resumeId).then(
      ({ files: f }) => {
        if (cancelled) return;
        setFiles(f);
        setSelected((s) => (s && f.some((x) => x.name === s) ? s : (f.find((x) => x.name.endsWith(".log"))?.name ?? null)));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [resumeId, buildId]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    api.outputText(resumeId, selected).then(
      (t) => !cancelled && setText(t),
      () => !cancelled && setText("(not a text file)"),
    );
    return () => {
      cancelled = true;
    };
  }, [resumeId, selected, buildId]);

  const textual = (n: string) => /\.(log|blg|aux|bbl|toc|out|lof|lot|ilg|ind|glg|nlg|fls|fdb_latexmk)$/.test(n);
  return (
    <div className="flex h-full min-h-0">
      <ul className="w-44 shrink-0 overflow-auto border-r py-1 text-[11.5px]">
        {files.length === 0 && <li className="px-3 py-1 text-muted-foreground">No output yet.</li>}
        {files.map((f) => (
          <li key={f.name} className="group flex items-center">
            <button
              type="button"
              disabled={!textual(f.name)}
              onClick={() => setSelected(f.name)}
              className={cn(
                "min-w-0 flex-1 truncate px-3 py-1 text-left font-mono text-muted-foreground enabled:hover:text-foreground disabled:opacity-60",
                selected === f.name && "bg-muted text-foreground",
              )}
            >
              {f.name}
            </button>
            <a
              href={api.outputFileUrl(resumeId, f.name, true)}
              className="pr-2 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
              aria-label={`Download ${f.name}`}
            >
              <Download className="size-3" />
            </a>
          </li>
        ))}
      </ul>
      <pre className="min-w-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {selected ? text : ""}
      </pre>
    </div>
  );
}

const ICON = {
  error: <CircleX className="size-3.5 shrink-0 text-destructive" />,
  warning: <CircleAlert className="size-3.5 shrink-0 text-warning" />,
  info: <Info className="size-3.5 shrink-0 text-muted-foreground" />,
};

export function countBySeverity(diags: Diagnostic[]) {
  return {
    error: diags.filter((d) => d.severity === "error").length,
    warning: diags.filter((d) => d.severity === "warning").length,
    info: diags.filter((d) => d.severity === "info").length,
  };
}

/** Build problems (errors, warnings, layout notes) with jump-to-line, plus the raw latexmk output. */
export function ProblemsPanel({ resumeId, result, onJump }: Props) {
  const [tab, setTab] = useState<"problems" | "output" | "logs">("problems");
  const [show, setShow] = useState<Record<Severity, boolean>>({ error: true, warning: true, info: false });
  const diags = useMemo(() => result?.diagnostics ?? [], [result]);
  const counts = countBySeverity(diags);
  const visible = diags.filter((d) => show[d.severity]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/40">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2 text-xs">
        <button
          type="button"
          onClick={() => setTab("problems")}
          className={cn("rounded-md px-2 py-1 font-medium text-muted-foreground hover:text-foreground", tab === "problems" && "bg-muted text-foreground")}
        >
          Problems
          {counts.error + counts.warning > 0 && <span className="ml-1.5 tabular-nums text-muted-foreground">{counts.error + counts.warning}</span>}
        </button>
        <button
          type="button"
          onClick={() => setTab("output")}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-muted-foreground hover:text-foreground",
            tab === "output" && "bg-muted text-foreground",
          )}
        >
          <TerminalSquare className="size-3.5" />
          Output
        </button>
        <button
          type="button"
          onClick={() => setTab("logs")}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-muted-foreground hover:text-foreground",
            tab === "logs" && "bg-muted text-foreground",
          )}
        >
          <FileText className="size-3.5" />
          Logs &amp; files
        </button>
        {tab === "problems" && (
          <div className="ml-auto flex items-center gap-1">
            {(["error", "warning", "info"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={show[s]}
                onClick={() => setShow((v) => ({ ...v, [s]: !v[s] }))}
                className={cn(
                  "flex items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5 tabular-nums text-muted-foreground transition-colors hover:text-foreground",
                  show[s] ? "border-border bg-muted/60 text-foreground" : "opacity-60",
                )}
                title={`${show[s] ? "Hide" : "Show"} ${s === "info" ? "notes" : `${s}s`}`}
              >
                {ICON[s]}
                {counts[s]}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "logs" ? (
          <LogsAndFiles resumeId={resumeId} buildId={result?.id ?? null} />
        ) : tab === "output" ? (
          <pre className="p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground">{result?.outputTail || "No output yet."}</pre>
        ) : !result ? (
          <p className="p-3 text-xs text-muted-foreground">Not compiled yet.</p>
        ) : visible.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            {diags.length === 0 ? "No problems. The document compiled cleanly." : "Nothing to show with the current filters."}
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {visible.map((d, i) => {
              const target = d.file && d.line ? { file: d.file, line: d.line } : null;
              return (
                <li key={i}>
                  <button
                    type="button"
                    disabled={!target}
                    onClick={() => target && onJump(target.file, target.line)}
                    className="group flex w-full items-start gap-2 px-3 py-2 text-left text-xs enabled:hover:bg-muted/50"
                  >
                    <span className="mt-px">{ICON[d.severity]}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-foreground">{d.message}</span>
                      {d.detail && (
                        <span className="mt-1 block font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">{d.detail}</span>
                      )}
                    </span>
                    {(d.file || d.line) && (
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground group-enabled:group-hover:text-primary">
                        {d.file ?? ""}
                        {d.line ? `:${d.line}` : ""}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
