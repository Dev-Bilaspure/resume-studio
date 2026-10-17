import type { FitAssessment } from "@resume-studio/tailor";
import { cn } from "@/lib/utils";

const LEVEL: Record<FitAssessment["level"], { label: string; cls: string; dot: string }> = {
  strong: { label: "Strong fit", cls: "border-success/30 bg-success/10", dot: "bg-success" },
  stretch: { label: "Stretch", cls: "border-warning/30 bg-warning/10", dot: "bg-warning" },
  "long-shot": { label: "Long shot", cls: "border-destructive/30 bg-destructive/10", dot: "bg-destructive" },
};

/**
 * How well the resume fits the job before any rewriting. Tailoring makes real experience visible; it
 * can't add what isn't there, so this says where an application can win.
 */
export function FitCard({ fit, className }: { fit: FitAssessment; className?: string }) {
  const l = LEVEL[fit.level];
  const { strong, weak, total } = fit.must;
  const line =
    fit.level === "strong"
      ? `Your resume clearly shows ${strong} of ${total} must-haves${weak ? ` (${weak} more in part)` : ""}. A good use of an application.`
      : fit.level === "stretch"
        ? `${strong} of ${total} must-haves clearly shown${weak ? `, ${weak} in part` : ""}. Tailoring can help here, but some requirements aren't on your resume.`
        : `Only ${strong} of ${total} must-haves clearly shown. Tailoring makes real experience visible; it can't add what's missing.`;
  return (
    <section className={cn("rounded-xl border px-4 py-3", l.cls, className)}>
      <p className="flex items-center gap-2 text-sm font-semibold">
        <span className={cn("size-2 rounded-full", l.dot)} aria-hidden />
        {l.label}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{line}</p>
      {fit.gaps.length > 0 && (
        <div className="mt-2">
          <p className="text-xs text-muted-foreground">
            Not on your resume{fit.hardGap ? " (including a years or degree requirement, which is hard to argue past)" : ""}:
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
            {fit.gaps.slice(0, 5).map((g, i) => (
              <li key={i}>{g}</li>
            ))}
            {fit.gaps.length > 5 && <li className="text-muted-foreground">and {fit.gaps.length - 5} more</li>}
          </ul>
        </div>
      )}
    </section>
  );
}

export function FitDot({ level }: { level: FitAssessment["level"] }) {
  return (
    <span className="flex items-center gap-1" title={LEVEL[level].label}>
      <span className={cn("size-1.5 rounded-full", LEVEL[level].dot)} aria-hidden />
      {LEVEL[level].label}
    </span>
  );
}
