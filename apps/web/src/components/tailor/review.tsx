"use client";

import type { Edit, EvidenceRef, Fact, Requirement } from "@resume-studio/tailor";
import { ArrowRight, BookmarkCheck, ChevronDown, CircleAlert, Info, Loader2, Save, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PdfPreview } from "@/components/preview/pdf-preview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { editContext, elementText, jobTitle, plainText, tailorApi, wordDiff, type PreviewResult, type SessionView } from "@/lib/tailor-api";
import { cn } from "@/lib/utils";
import { FactsDialog } from "./facts-dialog";
import { MatchDot } from "./session-view";

const OP_LABEL: Record<Edit["change"]["op"], string> = {
  rewrite_bullet: "Rewrote a bullet",
  add_bullet: "Added a bullet",
  remove_bullet: "Removed a bullet",
  reorder_bullets: "Reordered bullets",
  rewrite_paragraph: "Rewrote the summary",
  set_headline: "Changed the headline",
  rewrite_skills: "Updated skills",
};

type Tab = "changes" | "requirements" | "keywords";

export function Review({ session }: { session: SessionView }) {
  const router = useRouter();
  const edits = useMemo(() => session.edits ?? [], [session.edits]);
  const usable = useMemo(() => edits.filter((e) => e.status !== "dropped"), [edits]);
  const dropped = edits.filter((e) => e.status === "dropped");
  const [accepted, setAccepted] = useState<Set<string>>(() => new Set(usable.map((e) => e.id)));
  const [tab, setTab] = useState<Tab>("changes");
  const [view, setView] = useState<"tailored" | "original">("tailored");
  // Narrow windows show one pane at a time.
  const [pane, setPane] = useState<"changes" | "pdf">("changes");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [originalPdf, setOriginalPdf] = useState<string | null>(null);
  const [name, setName] = useState(`${session.context.resumeName ?? "Resume"} · ${session.job.company || jobTitle(session.job)}`);
  const [saving, setSaving] = useState(false);
  const [factsOpen, setFactsOpen] = useState(false);
  const facts: Fact[] = useMemo(() => [...session.facts, ...session.newFacts], [session.facts, session.newFacts]);

  useEffect(() => {
    api.get(session.context.resumeId).then(
      (d) => setOriginalPdf(d.build.lastGood?.pdfUrl ?? null),
      () => {},
    );
  }, [session.context.resumeId]);

  // The preview follows your choices: rebuilt (debounced) whenever the accepted set changes.
  const key = [...accepted].sort().join(",");
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      ctl.current?.abort();
      const c = new AbortController();
      ctl.current = c;
      setPreviewing(true);
      tailorApi
        .preview(session.id, key ? key.split(",") : [], c.signal)
        .then((r) => {
          if (!c.signal.aborted) setPreview(r);
        })
        .catch((e) => {
          if ((e as Error).name !== "AbortError") toast.error("Couldn't build the preview", { description: (e as Error).message });
        })
        .finally(() => {
          if (!c.signal.aborted) setPreviewing(false);
        });
    }, 700);
    return () => clearTimeout(t);
  }, [key, session.id]);
  useEffect(() => () => ctl.current?.abort(), []);

  const toggle = (id: string, on: boolean) =>
    setAccepted((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const meta = await tailorApi.finalize(session.id, [...accepted], name.trim());
      toast.success("Saved as a new resume", { description: `${meta.name}. The job description is saved with it as jd.md.` });
      router.push(`/r/${encodeURIComponent(meta.id)}`);
    } catch (e) {
      toast.error("Couldn't save", { description: (e as Error).message });
      setSaving(false);
    }
  };

  const report = session.report;
  const requirements = session.profile?.requirements ?? [];
  const groups = useMemo(() => {
    const out = new Map<string, Edit[]>();
    for (const e of usable) {
      const sec = editContext(session.doc, e.change).section || "Other";
      out.set(sec, [...(out.get(sec) ?? []), e]);
    }
    return [...out.entries()];
  }, [usable, session.doc]);

  const pdfUrl = view === "original" ? originalPdf : (preview?.url ?? null);

  return (
    <div className="grid h-full grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,46%)]">
      <div className={cn("min-h-0 flex-col border-r lg:flex", pane === "pdf" ? "hidden" : "flex")}>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-5 px-6 py-6">
            {report && <Scoreboard session={session} preview={preview} />}

            {session.strategy && (
              <section className="rounded-xl border bg-card p-4">
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">The approach</p>
                <p className="mt-1.5 text-sm leading-relaxed">{session.strategy}</p>
              </section>
            )}

            <Warnings session={session} />

            {session.newFacts.length > 0 && (
              <p className="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs text-muted-foreground">
                <BookmarkCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
                <span>
                  {session.newFacts.length} fact{session.newFacts.length === 1 ? "" : "s"} from your answers {session.newFacts.length === 1 ? "was" : "were"}{" "}
                  saved to your profile for future applications.{" "}
                  <button type="button" className="text-primary hover:underline" onClick={() => setFactsOpen(true)}>
                    Manage
                  </button>
                </span>
              </p>
            )}

            <div className="flex items-center gap-1 border-b">
              {(
                [
                  ["changes", `Changes (${usable.length})`],
                  ["requirements", `Requirements (${requirements.length})`],
                  ["keywords", "Keywords"],
                ] as const
              ).map(([t, label]) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn(
                    "-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground",
                    tab === t && "border-primary text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
              {tab === "changes" && usable.length > 0 && (
                <span className="ml-auto flex gap-1 pb-1">
                  <Button size="xs" variant="ghost" onClick={() => setAccepted(new Set(usable.map((e) => e.id)))}>
                    Accept all
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setAccepted(new Set())}>
                    None
                  </Button>
                </span>
              )}
            </div>

            {tab === "changes" &&
              (usable.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No changes passed the checks. Your resume already fits this job as well as it truthfully can.
                </p>
              ) : (
                <div className="space-y-6">
                  {groups.map(([section, list]) => (
                    <section key={section}>
                      <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{section}</h3>
                      <ul className="space-y-3">
                        {list.map((e) => (
                          <EditCard
                            key={e.id}
                            edit={e}
                            session={session}
                            facts={facts}
                            requirements={requirements}
                            accepted={accepted.has(e.id)}
                            onToggle={(on) => toggle(e.id, on)}
                          />
                        ))}
                      </ul>
                    </section>
                  ))}
                  {dropped.length > 0 && <Dropped edits={dropped} session={session} />}
                </div>
              ))}

            {tab === "requirements" && <Requirements session={session} accepted={accepted} />}
            {tab === "keywords" && <Keywords session={session} />}
          </div>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-background/90 px-6 py-3 backdrop-blur">
          <span className="text-xs text-muted-foreground tabular-nums">
            {accepted.size} of {usable.length} change{usable.length === 1 ? "" : "s"} accepted
          </span>
          <Button variant="outline" size="sm" className="lg:hidden" onClick={() => setPane("pdf")}>
            Preview PDF
          </Button>
          <Input className="ml-auto h-8 w-72 max-w-full" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name of the new resume" />
          <Button disabled={saving || !name.trim()} onClick={() => void save()}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            Save as new resume
          </Button>
        </footer>
      </div>

      <FactsDialog open={factsOpen} onOpenChange={setFactsOpen} />
      <div className={cn("min-h-0 flex-col lg:flex", pane === "pdf" ? "flex" : "hidden")}>
        <PdfPreview
          url={pdfUrl}
          className="min-h-0 flex-1"
          toolbarExtra={
            <span className="flex items-center gap-2">
              <Button variant="outline" size="xs" className="lg:hidden" onClick={() => setPane("changes")}>
                Changes
              </Button>
              {view === "tailored" && previewing && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Updating the preview" />}
              {view === "tailored" && preview?.errors.length ? (
                <span className="flex items-center gap-1 text-[11px] text-destructive" title={preview.errors.join("\n")}>
                  <CircleAlert className="size-3" /> Build errors
                </span>
              ) : null}
              <span className="flex rounded-md bg-muted p-0.5 text-[11px]">
                {(["tailored", "original"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setView(v)}
                    className={cn("rounded px-2 py-0.5 font-medium text-muted-foreground capitalize", view === v && "bg-background text-foreground shadow-sm")}
                  >
                    {v}
                  </button>
                ))}
              </span>
            </span>
          }
        />
      </div>
    </div>
  );
}

// ---- Scores ---------------------------------------------------------------------------------------------------

function Scoreboard({ session, preview }: { session: SessionView; preview: PreviewResult | null }) {
  const r = session.report!;
  const kwTotal = r.before.keywordsFound.length + r.before.keywordsMissing.length;
  const covered = (c: typeof r.before) => c.requirementsStrong;
  const stats = [
    {
      label: "Requirements clearly shown",
      before: covered(r.before),
      after: covered(r.after),
      of: r.before.requirementsTotal,
      hint: "Requirements your resume demonstrates with a specific bullet or fact.",
    },
    {
      label: "Must-have keywords",
      before: r.before.keywordsFound.length,
      after: r.after.keywordsFound.length,
      of: kwTotal,
      hint: "Searchable terms recruiters filter on, found in the PDF text.",
    },
    { label: "Pages", before: r.before.build?.pages ?? null, after: preview?.pages ?? r.after.build?.pages ?? null, hint: "Of the built PDF." },
    {
      label: "ATS readiness",
      before: r.before.build?.atsScore ?? null,
      after: preview?.atsScore ?? r.after.build?.atsScore ?? null,
      hint: "How cleanly an ATS parses the PDF (same check as the editor).",
    },
  ];
  return (
    <section className="grid grid-cols-2 gap-2 xl:grid-cols-4">
      {stats.map((s) => {
        const up = s.before !== null && s.after !== null && s.after > s.before && s.label !== "Pages";
        return (
          <div key={s.label} className="rounded-xl border bg-card px-3 py-2.5" title={s.hint}>
            <p className="text-[11px] text-muted-foreground">{s.label}</p>
            <p className="mt-1 flex items-baseline gap-1.5 tabular-nums">
              <span className="text-sm text-muted-foreground">{s.before ?? "–"}</span>
              <ArrowRight className="size-3 self-center text-muted-foreground" />
              <span className={cn("text-lg font-semibold", up && "text-success")}>{s.after ?? "–"}</span>
              {"of" in s && s.of ? <span className="text-xs text-muted-foreground">/ {s.of}</span> : null}
            </p>
          </div>
        );
      })}
    </section>
  );
}

function Warnings({ session }: { session: SessionView }) {
  const deal = session.profile?.dealBreakers ?? [];
  // The engine also lists each deal-breaker as a "Check: …" warning (for clients that don't show them);
  // they're shown above already.
  const warnings = (session.report?.warnings ?? []).filter((w) => !deal.some((d) => w === `Check: ${d.text}`));
  if (!deal.length && !warnings.length) return null;
  return (
    <section className="space-y-2">
      {deal.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <div>
            <p className="font-medium">Hard requirements a resume can&apos;t change</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              {deal.map((d, i) => (
                <li key={i}>{d.text}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <ul className="space-y-0.5">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ---- One change -----------------------------------------------------------------------------------------------

function EditCard({
  edit,
  session,
  facts,
  requirements,
  accepted,
  onToggle,
}: {
  edit: Edit;
  session: SessionView;
  facts: Fact[];
  requirements: Requirement[];
  accepted: boolean;
  onToggle(on: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const ctx = editContext(session.doc, edit.change);
  const serves = edit.requirements.map((id) => requirements.find((r) => r.id === id)).filter((r): r is Requirement => !!r);
  return (
    <li className={cn("rounded-xl border bg-card transition-opacity", !accepted && "opacity-60")}>
      <div className="flex items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-medium">{OP_LABEL[edit.change.op]}</span>
            {ctx.where && <span className="truncate text-xs text-muted-foreground">{ctx.where}</span>}
            {edit.status === "flagged" && (
              <span className="rounded bg-warning/15 px-1 text-[10.5px] text-warning" title={edit.issues?.join("\n")}>
                check this
              </span>
            )}
          </div>
          <ChangeBody edit={edit} before={ctx.before} doc={session.doc} />
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{edit.reason}</p>
          {serves.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {serves.map((r) => (
                <span key={r.id} className="max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground" title={r.text}>
                  {r.text}
                </span>
              ))}
            </div>
          )}
          {edit.status === "flagged" && edit.issues?.length ? <p className="mt-2 text-xs text-warning">{edit.issues.join(" ")}</p> : null}
          {edit.evidence.length > 0 && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
              Based on {edit.evidence.length} source{edit.evidence.length === 1 ? "" : "s"}
            </button>
          )}
          {open && <Evidence refs={edit.evidence} session={session} facts={facts} />}
        </div>
        <Switch checked={accepted} onCheckedChange={(v) => onToggle(!!v)} aria-label={accepted ? "Accepted" : "Rejected"} className="mt-0.5" />
      </div>
    </li>
  );
}

function ChangeBody({ edit, before, doc }: { edit: Edit; before: string | null; doc: SessionView["doc"] }) {
  const c = edit.change;
  if (c.op === "remove_bullet")
    return <p className="mt-2 text-sm text-muted-foreground line-through decoration-destructive/60">{before ? plainText(before) : ""}</p>;
  if (c.op === "add_bullet") return <p className="mt-2 rounded-md bg-success/10 px-2 py-1 text-sm">{plainText(c.text)}</p>;
  if (c.op === "reorder_bullets") {
    const list = doc?.sections.flatMap((s) => s.lists).find((l) => l.id === c.target);
    const was = (id: string) => (list?.bullets.findIndex((b) => b.id === id) ?? -1) + 1;
    return (
      <ol className="mt-2 space-y-1">
        {c.order.map((id, i) => {
          const b = list?.bullets.find((x) => x.id === id);
          const from = was(id);
          return (
            <li key={id} className="flex items-baseline gap-2 text-sm">
              <span className="w-4 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
              <span className="min-w-0 flex-1 truncate" title={b ? plainText(b.text) : id}>
                {b ? plainText(b.text) : id}
              </span>
              {from > 0 && from !== i + 1 && <span className="shrink-0 text-[11px] text-muted-foreground">was {from}</span>}
            </li>
          );
        })}
      </ol>
    );
  }
  const parts = wordDiff(plainText(before ?? ""), plainText(c.text));
  return (
    <p className="mt-2 text-sm leading-relaxed">
      {parts.map((p, i) =>
        p.kind === "same" ? (
          <span key={i}>{p.text}</span>
        ) : p.kind === "add" ? (
          <span key={i} className="rounded-sm bg-success/15 text-success">
            {p.text}
          </span>
        ) : (
          // Spaced from an insertion right after it, so "Software Backend" doesn't read as one word.
          <span key={i} className={cn("rounded-sm text-muted-foreground line-through decoration-destructive/60", parts[i + 1]?.kind === "add" && "mr-1")}>
            {p.text}
          </span>
        ),
      )}
    </p>
  );
}

function Evidence({ refs, session, facts }: { refs: EvidenceRef[]; session: SessionView; facts: Fact[] }) {
  return (
    <ul className="mt-2 space-y-1 border-l-2 pl-3">
      {refs.map((r, i) => {
        const text = elementText(session.doc, facts, r.id);
        return (
          <li key={i} className="text-xs text-muted-foreground">
            <span className="mr-1 rounded bg-muted px-1 text-[10px] uppercase">{r.kind === "fact" ? "your answer" : r.kind}</span>
            {text ? plainText(text) : r.id}
          </li>
        );
      })}
    </ul>
  );
}

function Dropped({ edits, session }: { edits: Edit[]; session: SessionView }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-xl border border-dashed">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-xs text-muted-foreground">
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        {edits.length} suggestion{edits.length === 1 ? "" : "s"} left out because {edits.length === 1 ? "it" : "they"} didn&apos;t pass the fact-check or the
        build
      </button>
      {open && (
        <ul className="space-y-3 px-4 pb-4">
          {edits.map((e) => {
            const ctx = editContext(session.doc, e.change);
            return (
              <li key={e.id} className="text-xs">
                <p className="font-medium">
                  {OP_LABEL[e.change.op]} <span className="font-normal text-muted-foreground">{ctx.where}</span>
                </p>
                {"text" in e.change && <p className="mt-0.5 text-muted-foreground">{plainText(e.change.text)}</p>}
                <p className="mt-0.5 text-destructive">{e.issues?.join(" ")}</p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---- Requirements & keywords ----------------------------------------------------------------------------------

function Requirements({ session, accepted }: { session: SessionView; accepted: Set<string> }) {
  const reqs = session.profile?.requirements ?? [];
  const edits = session.edits ?? [];
  const order = { must: 0, nice: 1 };
  return (
    <ul className="space-y-2">
      {[...reqs]
        .sort((a, b) => order[a.kind] - order[b.kind])
        .map((r) => {
          const m = session.matches?.find((x) => x.requirementId === r.id);
          const by = edits.filter((e) => e.requirements.includes(r.id) && accepted.has(e.id));
          return (
            <li key={r.id} className="flex items-start gap-2.5 rounded-lg border bg-card px-3 py-2.5">
              <MatchDot status={m?.status} />
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  {r.text}
                  <span className={cn("ml-2 text-[11px]", r.kind === "must" ? "text-foreground/70" : "text-muted-foreground")}>
                    {r.kind === "must" ? "must-have" : "nice to have"}
                  </span>
                </p>
                {m?.note && <p className="mt-0.5 text-xs text-muted-foreground">{m.note}</p>}
                {by.length > 0 && (
                  <p className="mt-1 text-[11px] text-success">
                    Strengthened by {by.length} accepted change{by.length === 1 ? "" : "s"}
                  </p>
                )}
                {m?.status === "missing" && !by.length && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Not on your resume. If you have this experience, add it in the editor or answer it next time.
                  </p>
                )}
              </div>
            </li>
          );
        })}
    </ul>
  );
}

function Keywords({ session }: { session: SessionView }) {
  const r = session.report;
  const kws = (session.profile?.keywords ?? []).filter((k) => (k.kind ?? "term") === "term");
  if (!r) return null;
  const was = new Set(r.before.keywordsFound);
  const now = new Set(r.after.keywordsFound);
  const nice = kws.filter((k) => k.importance === "nice");
  const chip = (term: string, state: "added" | "kept" | "missing") => (
    <span
      key={term}
      className={cn(
        "rounded-md px-1.5 py-0.5 text-xs",
        state === "added" && "bg-success/15 text-success",
        state === "kept" && "bg-muted text-foreground",
        state === "missing" && "border border-dashed text-muted-foreground",
      )}
      title={state === "added" ? "Added by this tailoring" : state === "kept" ? "Already on your resume" : "Not on your resume"}
    >
      {term}
    </span>
  );
  const must = [...now, ...r.after.keywordsMissing];
  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">Must-have terms (in the built PDF)</p>
        <div className="flex flex-wrap gap-1.5">{must.map((t) => chip(t, now.has(t) ? (was.has(t) ? "kept" : "added") : "missing"))}</div>
        {r.after.keywordsMissing.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Missing terms are left out on purpose: they&apos;d only be added where your experience backs them.
          </p>
        )}
      </div>
      {nice.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">Nice to have</p>
          <div className="flex flex-wrap gap-1.5">
            {nice.map((k) => (
              <span key={k.term} className="rounded-md bg-muted/60 px-1.5 py-0.5 text-xs text-muted-foreground">
                {k.term}
              </span>
            ))}
          </div>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Concepts like &ldquo;distributed systems&rdquo; are shown by your work, not by the word, so they&apos;re tracked under{" "}
        <span className="text-foreground">Requirements</span>.
      </p>
    </div>
  );
}
