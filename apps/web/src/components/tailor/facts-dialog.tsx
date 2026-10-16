"use client";

import type { Fact } from "@resume-studio/tailor";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { tailorApi } from "@/lib/tailor-api";

interface Row {
  id: string;
  text: string;
  skills: string;
  source: Fact["source"];
  createdAt: string;
}

const toRow = (f: Fact): Row => ({ ...f, skills: f.skills.join(", ") });

/**
 * Your fact bank: true things about you that tailoring may use (learned from your answers, or added
 * here). Stored as resumes/_profile/facts.json.
 */
export function FactsDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange(open: boolean): void; onSaved?(count: number): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">{open && <FactsEditor onDone={() => onOpenChange(false)} onSaved={onSaved} />}</DialogContent>
    </Dialog>
  );
}

function FactsEditor({ onDone, onSaved }: { onDone(): void; onSaved?(count: number): void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    tailorApi.facts().then(
      (d) => setRows(d.facts.map(toRow)),
      (e) => {
        toast.error("Couldn't load your facts", { description: (e as Error).message });
        setRows([]);
      },
    );
  }, []);

  const update = (id: string, patch: Partial<Row>) => setRows((r) => r!.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const save = async () => {
    if (!rows) return;
    setSaving(true);
    try {
      const facts: Fact[] = rows
        .filter((r) => r.text.trim())
        .map((r) => ({
          id: r.id,
          text: r.text.trim(),
          skills: r.skills
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          source: r.source,
          createdAt: r.createdAt,
        }));
      await tailorApi.saveFacts(facts);
      onSaved?.(facts.length);
      toast.success("Facts saved");
      onDone();
    } catch (e) {
      toast.error("Couldn't save your facts", { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Your facts</DialogTitle>
        <DialogDescription>
          True things about your work that tailoring may use, even when a resume doesn&apos;t say them yet. Learned from your answers, or added here. Keep each
          to one claim you could defend in an interview.
        </DialogDescription>
      </DialogHeader>
      {rows === null ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="-mx-1 max-h-[55vh] space-y-3 overflow-y-auto px-1">
          {rows.length === 0 && <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">No facts yet.</p>}
          {rows.map((r) => (
            <div key={r.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-start gap-2">
                <Textarea className="min-h-14 text-sm" value={r.text} onChange={(e) => update(r.id, { text: e.target.value })} aria-label="Fact" />
                <Button variant="ghost" size="icon-sm" aria-label="Delete fact" title="Delete" onClick={() => setRows((x) => x!.filter((y) => y.id !== r.id))}>
                  <Trash2 />
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  className="h-7 text-xs"
                  value={r.skills}
                  onChange={(e) => update(r.id, { skills: e.target.value })}
                  placeholder="Skills it proves, comma-separated"
                  aria-label="Skills"
                />
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {r.source === "answer" ? "from an answer" : r.source === "manual" ? "added by you" : "imported"}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      <DialogFooter className="sm:justify-between">
        <Button
          variant="outline"
          disabled={!rows}
          onClick={() =>
            setRows((x) => [
              ...(x ?? []),
              {
                id: `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                text: "",
                skills: "",
                source: "manual",
                createdAt: new Date().toISOString(),
              },
            ])
          }
        >
          <Plus />
          Add a fact
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button disabled={!rows || saving} onClick={() => void save()}>
            {saving && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
