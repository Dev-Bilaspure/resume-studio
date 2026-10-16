"use client";

import { Settings2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AiSettingsDialog } from "@/components/ai/ai-settings-dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { aiApi, type AiSettings, type ProviderId, type ProviderInfo } from "@/lib/tailor-api";

const SHORT: Record<ProviderId, string> = { "claude-code": "Claude Code", anthropic: "Anthropic", openai: "OpenAI", vertex: "Vertex AI" };

export interface ModelChoice {
  provider: ProviderId;
  model: string;
}

/**
 * Which provider and model a run uses: your default, preselected; any configured provider can be picked
 * for this run. "Set up" opens the provider settings.
 */
export function ModelPicker({ value, onChange }: { value: ModelChoice | null; onChange(v: ModelChoice): void }) {
  const [catalog, setCatalog] = useState<ProviderInfo[]>([]);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [open, setOpen] = useState(false);

  const apply = useCallback(
    (cat: ProviderInfo[], s: AiSettings, keep: ModelChoice | null) => {
      setCatalog(cat);
      setSettings(s);
      const current = keep && s.providers.find((p) => p.id === keep.provider && p.configured);
      if (current) {
        if (current.model !== keep.model) onChange({ provider: current.id, model: current.model });
        return;
      }
      const pick = s.providers.find((p) => p.id === s.defaultProvider && p.configured) ?? s.providers.find((p) => p.configured);
      if (pick) onChange({ provider: pick.id, model: pick.model });
    },
    [onChange],
  );

  useEffect(() => {
    aiApi.get().then(
      (d) => apply(d.catalog, d.settings, null),
      () => {},
    );
    // Only on mount: later changes come from the settings dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const configured = settings?.providers.filter((p) => p.configured) ?? [];
  const label = (id: ProviderId) => SHORT[id] ?? catalog.find((c) => c.id === id)?.label ?? id;
  const items = configured.map((p) => ({ value: p.id, label: `${label(p.id)} · ${p.model}` }));

  return (
    <div className="flex min-w-0 items-center gap-2">
      {configured.length ? (
        <Select
          items={items}
          value={value?.provider ?? null}
          onValueChange={(v) => {
            const p = configured.find((x) => x.id === v);
            if (p) onChange({ provider: p.id, model: p.model });
          }}
        >
          <SelectTrigger className="w-full min-w-0 flex-1">
            <SelectValue placeholder="Choose a model" />
          </SelectTrigger>
          <SelectContent>
            {items.map((i) => (
              <SelectItem key={i.value} value={i.value}>
                {i.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p className="flex-1 text-sm text-muted-foreground">{settings ? "No AI provider set up yet." : "Loading…"}</p>
      )}
      {configured.length ? (
        <Button type="button" variant="outline" size="icon" aria-label="AI providers" title="AI providers" onClick={() => setOpen(true)}>
          <Settings2 />
        </Button>
      ) : (
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          <Settings2 />
          Set up
        </Button>
      )}
      <AiSettingsDialog open={open} onOpenChange={setOpen} initialProvider={value?.provider} onSaved={(s) => apply(catalog, s, value)} />
    </div>
  );
}
