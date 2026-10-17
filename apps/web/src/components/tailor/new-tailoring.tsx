"use client";

import { ArrowRight, Loader2, ShieldCheck, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PdfThumb } from "@/components/preview/pdf-thumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, type ResumeSummary } from "@/lib/api";
import { tailorApi } from "@/lib/tailor-api";
import { cn } from "@/lib/utils";
import { FactsDialog } from "./facts-dialog";
import { ModelPicker, type ModelChoice } from "./model-picker";
import { TailorHeader } from "./tailor-header";

const SENIORITY = [
  { value: "auto", label: "Read it from the posting" },
  { value: "intern", label: "Intern" },
  { value: "junior", label: "Junior / new grad" },
  { value: "mid", label: "Mid-level" },
  { value: "senior", label: "Senior" },
  { value: "staff", label: "Staff" },
  { value: "principal", label: "Principal" },
  { value: "manager", label: "Engineering manager" },
] as const;

const DRAFT_KEY = "rs:tailor-draft";

interface Draft {
  company: string;
  role: string;
  seniority: (typeof SENIORITY)[number]["value"];
  location: string;
  link: string;
  description: string;
  notes: string;
}

const EMPTY: Draft = { company: "", role: "", seniority: "auto", location: "", link: "", description: "", notes: "" };

function loadDraft(): Draft {
  try {
    return { ...EMPTY, ...(JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "{}") as Partial<Draft>) };
  } catch {
    return EMPTY;
  }
}

export function NewTailoring({ resumeId }: { resumeId: string | null }) {
  const router = useRouter();
  const [resumes, setResumes] = useState<ResumeSummary[] | null>(null);
  const [base, setBase] = useState<string | null>(resumeId);
  // Rendered on the client only (see NewTailoringLoader), so the saved draft can seed the first render.
  const [job, setJob] = useState<Draft>(loadDraft);
  const [pages, setPages] = useState<string>("keep");
  const [allowHeadline, setAllowHeadline] = useState(true);
  const [askQuestions, setAskQuestions] = useState(true);
  const [model, setModel] = useState<ModelChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [factCount, setFactCount] = useState<number | null>(null);
  const [factsOpen, setFactsOpen] = useState(false);

  // The job you were typing survives a reload or a detour to the editor (this tab only).
  useEffect(() => {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(job));
    } catch {
      // Storage unavailable: nothing to keep.
    }
  }, [job]);

  useEffect(() => {
    api.list().then(
      (d) => {
        // Tailor from a base resume, not from another tailored copy, unless that's all there is.
        setResumes(d.resumes);
        setBase((b) => b ?? d.resumes.find((r) => !r.application)?.id ?? d.resumes[0]?.id ?? null);
      },
      () => setResumes([]),
    );
  }, []);

  useEffect(() => {
    tailorApi.facts().then(
      (d) => setFactCount(d.facts.length),
      () => {},
    );
  }, []);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setJob((j) => ({ ...j, [k]: v }));
  const onModel = useCallback((m: ModelChoice) => setModel(m), []);
  const baseResume = resumes?.find((r) => r.id === base);
  const descLength = job.description.trim().length;
  const problems = {
    description: descLength < 80 && (descLength ? "That looks short. Paste the whole posting." : "Paste the job posting"),
  };
  const valid = !!base && !problems.description && !!model;

  // Paste the posting, and the details fill themselves in: only empty fields, never what you typed.
  const [reading, setReading] = useState(false);
  const [filled, setFilled] = useState<Set<"company" | "role" | "seniority" | "location">>(new Set());
  const lastRead = useRef("");
  // The posting states no title, so the one filled in is a suggestion.
  const [roleSuggested, setRoleSuggested] = useState(false);
  const jobRef = useRef(job);
  useEffect(() => {
    jobRef.current = job;
  });
  const description = job.description.trim();
  useEffect(() => {
    if (description.length < 200 || description === lastRead.current || !model) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      lastRead.current = description;
      setReading(true);
      tailorApi
        .readPosting({ description, provider: model.provider, model: model.model }, ctl.signal)
        .then((d) => {
          // What you've typed by the time the answer arrives wins.
          const j = jobRef.current;
          const next = { ...j };
          const got = new Set<"company" | "role" | "seniority" | "location">();
          const title = d.role ?? d.suggestedRole;
          if (!j.company.trim() && d.company) {
            next.company = d.company;
            got.add("company");
          }
          if (!j.role.trim() && title) {
            next.role = title;
            got.add("role");
          }
          setRoleSuggested(!d.role);
          if (j.seniority === "auto" && d.seniority) {
            next.seniority = d.seniority;
            got.add("seniority");
          }
          if (!j.location.trim() && d.location) {
            next.location = d.location;
            got.add("location");
          }
          setJob(next);
          setFilled(got);
        })
        .catch(() => {
          // Best effort: the fields stay as they are, and the engine reads the posting anyway.
        })
        .finally(() => {
          if (!ctl.signal.aborted) setReading(false);
        });
    }, 800);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [description, model]);
  const fromPosting = (k: "company" | "role" | "seniority" | "location") =>
    filled.has(k) ? (
      <span className={cn("ml-auto text-[11px] font-normal", k === "role" && roleSuggested ? "text-warning" : "text-primary")}>
        {k === "role" && roleSuggested ? "suggested: the posting names no title" : "from the posting"}
      </span>
    ) : null;
  const edit = <K extends "company" | "role" | "location">(k: K, v: string) => {
    set(k, v);
    setFilled((f) => {
      const n = new Set(f);
      n.delete(k);
      return n;
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!valid || !base || !model) return;
    setBusy(true);
    try {
      const { id } = await tailorApi.start({
        resumeId: base,
        job: {
          company: job.company.trim(),
          role: job.role.trim(),
          seniority: job.seniority === "auto" ? undefined : job.seniority,
          description: job.description.trim(),
          location: job.location.trim() || undefined,
          link: job.link.trim() || undefined,
          notes: job.notes.trim() || undefined,
        },
        options: { maxPages: pages === "keep" ? undefined : Number(pages), allowHeadline, askQuestions },
        provider: model.provider,
        model: model.model,
      });
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch {
        // Ignore.
      }
      router.push(`/tailor/${id}`);
    } catch (err) {
      toast.error("Couldn't start tailoring", { description: (err as Error).message });
      setBusy(false);
    }
  };

  const err = (k: keyof typeof problems) => (touched && problems[k] ? <p className="text-xs text-destructive">{problems[k]}</p> : null);

  return (
    <div className="min-h-dvh bg-[radial-gradient(60rem_26rem_at_50%_-10rem,var(--glow),transparent_70%)] bg-no-repeat">
      <TailorHeader crumbs={<span className="font-medium">Tailor for a job</span>} />
      <form onSubmit={submit} className="mx-auto grid max-w-6xl gap-8 px-6 py-8 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-6">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <Sparkles className="size-5 text-primary" />
              Tailor a resume for a job
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Paste the posting. Resume Studio maps every requirement to your experience, rewrites what&apos;s relevant in the job&apos;s language, and checks
              every change against what your resume already says. You review each edit before anything is saved.
            </p>
          </div>

          <section className="grid gap-4 rounded-xl border bg-card p-5">
            <div className="grid gap-1.5">
              <Label htmlFor="jd" className="flex items-center">
                Job posting
                <span className="ml-auto text-[11px] font-normal text-muted-foreground tabular-nums">
                  {descLength ? `${descLength.toLocaleString()} characters` : ""}
                </span>
              </Label>
              <Textarea
                id="jd"
                autoFocus
                value={job.description}
                onChange={(e) => set("description", e.target.value)}
                placeholder="Paste the whole posting, as the company gives it: the role, responsibilities, requirements. Boilerplate is fine; it's ignored."
                className="max-h-[22rem] min-h-64 overflow-y-auto text-sm leading-relaxed"
                aria-invalid={touched && !!problems.description}
              />
              {err("description")}
            </div>

            <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Details</span>
              {reading ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" /> Reading the posting…
                </span>
              ) : (
                <span>Filled in from the posting when you paste it. Edit anything; all optional.</span>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="company" className="flex items-center">
                  Company {fromPosting("company")}
                </Label>
                <Input id="company" value={job.company} onChange={(e) => edit("company", e.target.value)} placeholder="Not named in the posting" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="role" className="flex items-center">
                  Role {fromPosting("role")}
                </Label>
                <Input id="role" value={job.role} onChange={(e) => edit("role", e.target.value)} placeholder="Read from the posting" />
              </div>
              <div className="grid gap-1.5">
                <Label className="flex items-center">Level {fromPosting("seniority")}</Label>
                <Select
                  items={SENIORITY.map((s) => ({ value: s.value, label: s.label }))}
                  value={job.seniority}
                  onValueChange={(v) => {
                    set("seniority", v as Draft["seniority"]);
                    setFilled((f) => {
                      const n = new Set(f);
                      n.delete("seniority");
                      return n;
                    });
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SENIORITY.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="location" className="flex items-center">
                  Location {fromPosting("location")}
                </Label>
                <Input id="location" value={job.location} onChange={(e) => edit("location", e.target.value)} placeholder="Remote (US), or Bangalore" />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="link">
                Link to the posting <span className="font-normal text-muted-foreground">(kept with the tailored resume)</span>
              </Label>
              <Input id="link" type="url" value={job.link} onChange={(e) => set("link", e.target.value)} placeholder="https://…" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="notes">Anything to emphasize or play down?</Label>
              <Textarea
                id="notes"
                value={job.notes}
                onChange={(e) => set("notes", e.target.value)}
                placeholder="e.g. Lead with the payments work at Foo; my Kafka experience is from the side project."
                className="min-h-16 text-sm"
              />
            </div>
          </section>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <section className="rounded-xl border bg-card p-4">
            <Label className="mb-2 block">Start from</Label>
            {resumes === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : resumes.length === 0 ? (
              <p className="text-sm text-muted-foreground">Create a resume first.</p>
            ) : (
              <>
                <Select items={resumes.map((r) => ({ value: r.id, label: r.name }))} value={base} onValueChange={(v) => setBase(String(v))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {resumes.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                        {r.application && <span className="ml-1 text-[11px] text-muted-foreground">· tailored for {r.application.company}</span>}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {baseResume?.build.pdfUrl && (
                  <div className="relative mt-3 max-h-40 overflow-hidden rounded-md ring-1 ring-black/20">
                    <PdfThumb url={baseResume.build.pdfUrl} />
                    <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" aria-hidden />
                  </div>
                )}
                {baseResume && baseResume.build.status && baseResume.build.status !== "ok" && (
                  <p className="mt-2 text-xs text-warning">This resume&apos;s last build failed. Fix it in the editor first so drafts can be checked.</p>
                )}
                <p className="mt-2 text-xs text-muted-foreground">The original isn&apos;t changed. The result is saved as a new resume.</p>
              </>
            )}
          </section>

          <section className="space-y-3 rounded-xl border bg-card p-4">
            <div className="grid gap-1.5">
              <Label>Model</Label>
              <ModelPicker value={model} onChange={onModel} />
            </div>
            <div className="grid gap-1.5">
              <Label>Length</Label>
              <Select
                items={[
                  { value: "keep", label: `Keep it at ${baseResume?.build.pages ?? "its current"} page${baseResume?.build.pages === 1 ? "" : "s"}` },
                  { value: "1", label: "1 page" },
                  { value: "2", label: "Up to 2 pages" },
                ]}
                value={pages}
                onValueChange={(v) => setPages(String(v))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="keep">
                    Keep it at {baseResume?.build.pages ?? "its current"} page{baseResume?.build.pages === 1 ? "" : "s"}
                  </SelectItem>
                  <SelectItem value="1">1 page</SelectItem>
                  <SelectItem value="2">Up to 2 pages</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-start justify-between gap-3">
              <span>
                <span className="block text-sm font-medium">Ask me about gaps first</span>
                <span className="block text-xs text-muted-foreground">
                  Questions about must-haves your resume doesn&apos;t show yet. Your answers are remembered.
                </span>
              </span>
              <Switch checked={askQuestions} onCheckedChange={(v) => setAskQuestions(!!v)} className="mt-0.5" />
            </label>
            <p className="-mt-1 text-xs text-muted-foreground">
              {factCount === null ? "" : factCount === 0 ? "No saved facts yet. " : `${factCount} saved fact${factCount === 1 ? "" : "s"}. `}
              <button type="button" className="text-primary hover:underline" onClick={() => setFactsOpen(true)}>
                {factCount ? "Manage" : "Add some"}
              </button>
            </p>
            <label className="flex items-start justify-between gap-3">
              <span>
                <span className="block text-sm font-medium">Match the headline to the role</span>
                <span className="block text-xs text-muted-foreground">The title under your name, when it&apos;s true for you.</span>
              </span>
              <Switch checked={allowHeadline} onCheckedChange={(v) => setAllowHeadline(!!v)} className="mt-0.5" />
            </label>
          </section>

          <Button type="submit" size="lg" className="w-full" disabled={busy || (touched && !valid)}>
            {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
            Tailor resume
            {!busy && <ArrowRight className="ml-auto" />}
          </Button>
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
            Nothing is invented. Every claim must trace back to your resume or to an answer you give, and no new numbers can appear.
          </p>
        </aside>
      </form>
      <FactsDialog open={factsOpen} onOpenChange={setFactsOpen} onSaved={setFactCount} />
    </div>
  );
}
