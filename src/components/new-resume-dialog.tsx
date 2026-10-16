"use client";

import { Check, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type ResumeSummary, type TemplateInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Pre-selects "duplicate this resume". */
  duplicateOf?: ResumeSummary | { id: string; name: string } | null;
}

export function NewResumeDialog({ open, onOpenChange, duplicateOf }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {/* Mounted per opening, so the form starts fresh each time. */}
        <NewResumeForm duplicateOf={duplicateOf ?? null} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function NewResumeForm({ duplicateOf, onDone }: { duplicateOf: Props["duplicateOf"]; onDone(): void }) {
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [resumes, setResumes] = useState<ResumeSummary[]>([]);
  const [source, setSource] = useState<string>(duplicateOf ? `resume:${duplicateOf.id}` : "template:classic");
  const [name, setName] = useState(duplicateOf ? `${duplicateOf.name} (copy)` : "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.list().then(
      (d) => {
        if (cancelled) return;
        setTemplates(d.templates);
        setResumes(d.resumes);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const [kind, value] = source.split(/:(.*)/s);
      const meta = await api.create({ name: name.trim(), ...(kind === "template" ? { template: value } : { duplicateOf: value }) });
      onDone();
      router.push(`/r/${encodeURIComponent(meta.id)}`);
    } catch (err) {
      toast.error("Couldn't create the resume", { description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  // A render function, not a component: a component defined here would remount (and lose focus) on every render.
  const option = (value: string, title: string, description: string) => (
    <button
      key={value}
      type="button"
      onClick={() => setSource(value)}
      className={cn(
        "relative flex flex-col items-start rounded-lg border p-3 text-left transition-colors hover:bg-muted/50",
        source === value ? "border-primary/60 bg-primary/5 ring-1 ring-primary/40" : "border-border",
      )}
    >
      <span className="text-sm font-medium">{title}</span>
      <span className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</span>
      {source === value && <Check className="absolute top-2.5 right-2.5 size-3.5 text-primary" />}
    </button>
  );

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>New resume</DialogTitle>
        <DialogDescription>Start from an ATS-safe template, or copy one of your resumes (e.g. to tailor it for a job).</DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor="resume-name">Name</Label>
        <Input id="resume-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Senior Backend Engineer — Acme" />
      </div>
      <div className="grid gap-2">
        <Label>Start from</Label>
        <div className="grid grid-cols-3 gap-2">{templates.map((t) => option(`template:${t.id}`, t.name, t.description))}</div>
        {resumes.length > 0 && (
          <>
            <p className="pt-1 text-xs text-muted-foreground">Or a copy of</p>
            <div className="grid max-h-40 gap-1 overflow-auto">
              {resumes.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    setSource(`resume:${r.id}`);
                    if (!name.trim()) setName(`${r.name} (copy)`);
                  }}
                  className={cn(
                    "flex items-center justify-between rounded-md border px-3 py-1.5 text-left text-sm transition-colors hover:bg-muted/50",
                    source === `resume:${r.id}` ? "border-primary/60 bg-primary/5" : "border-transparent",
                  )}
                >
                  <span className="truncate">{r.name}</span>
                  {source === `resume:${r.id}` && <Check className="size-3.5 shrink-0 text-primary" />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy && <Loader2 className="animate-spin" />}
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}
