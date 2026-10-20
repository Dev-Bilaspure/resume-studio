"use client";

import { Check, CircleAlert, ExternalLink, KeyRound, Loader2, PlugZap, Star } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { aiApi, type AiSettings, type FieldKey, type ProviderId, type ProviderInfo, type ProviderSettings } from "@/lib/tailor-api";
import { cn } from "@/lib/utils";

const CUSTOM = "__custom__";

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Opens on this provider (e.g. the one a failed run used). */
  initialProvider?: ProviderId;
  onSaved?(settings: AiSettings): void;
}

export function AiSettingsDialog({ open, onOpenChange, initialProvider, onSaved }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>AI provider</DialogTitle>
          <DialogDescription>
            Tailoring runs on the model you pick here. Keys stay on this computer (in the macOS Keychain; on Linux and Windows, in a file only you can read) and
            never reach the browser.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted per opening, so unsaved edits don't linger. */}
        {open && <AiSettingsBody initialProvider={initialProvider} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  );
}

function AiSettingsBody({ initialProvider, onSaved }: Pick<Props, "initialProvider" | "onSaved">) {
  const [catalog, setCatalog] = useState<ProviderInfo[] | null>(null);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [selected, setSelected] = useState<ProviderId>(initialProvider ?? "claude-code");

  useEffect(() => {
    aiApi.get().then(
      (d) => {
        setCatalog(d.catalog);
        setSettings(d.settings);
        if (!initialProvider && d.settings.defaultProvider) setSelected(d.settings.defaultProvider);
      },
      (e) => toast.error("Couldn't load AI settings", { description: (e as Error).message }),
    );
  }, [initialProvider]);

  if (!catalog || !settings) {
    return (
      <div className="flex h-96 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
      </div>
    );
  }

  const info = catalog.find((p) => p.id === selected)!;
  const saved = settings.providers.find((p) => p.id === selected)!;

  return (
    <div className="grid min-h-[26rem] grid-cols-[14rem_1fr]">
      <nav className="flex flex-col gap-1 border-r bg-muted/20 p-2" aria-label="Providers">
        {catalog.map((p) => {
          const s = settings.providers.find((x) => x.id === p.id)!;
          const isDefault = settings.defaultProvider === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelected(p.id)}
              className={cn(
                "flex flex-col items-start gap-1 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted",
                selected === p.id && "bg-muted ring-1 ring-border",
              )}
            >
              <span className="text-sm leading-tight font-medium">{p.label}</span>
              <span className="flex items-center gap-1.5 text-[11px]">
                {s.configured ? (
                  <span className="flex items-center gap-1 text-success">
                    <span className="size-1.5 rounded-full bg-success" /> Ready
                  </span>
                ) : (
                  <span className="text-muted-foreground">Not set up</span>
                )}
                {isDefault && (
                  <span className="flex items-center gap-0.5 rounded bg-primary/15 px-1 text-primary">
                    <Star className="size-2.5 fill-current" /> Default
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </nav>
      <ProviderForm
        key={selected}
        info={info}
        saved={saved}
        isDefault={settings.defaultProvider === selected}
        onSaved={(next) => {
          setSettings(next);
          onSaved?.(next);
        }}
      />
    </div>
  );
}

function ProviderForm({ info, saved, isDefault, onSaved }: { info: ProviderInfo; saved: ProviderSettings; isDefault: boolean; onSaved(s: AiSettings): void }) {
  // Secret fields start empty (their values never leave the server); typing replaces the saved one.
  const [values, setValues] = useState<Partial<Record<FieldKey, string>>>(() => ({ ...saved.values }));
  const [cleared, setCleared] = useState<Set<FieldKey>>(new Set());
  const [model, setModel] = useState(saved.model);
  const [models, setModels] = useState<{ id: string; label: string }[]>(info.models);
  const [modelsNote, setModelsNote] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [makeDefault, setMakeDefault] = useState(isDefault);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<
    { state: "idle" | "running" } | { state: "ok"; latencyMs: number; model: string } | { state: "error"; message: string; kind: string }
  >({
    state: "idle",
  });
  const testAbort = useRef<AbortController | null>(null);
  const [customModel, setCustomModel] = useState(() => !!saved.model && !info.models.some((m) => m.id === saved.model) && info.models.length > 0);

  // What to send: typed values, plus "" for secrets you removed.
  const payload = useCallback(() => {
    const out: Partial<Record<FieldKey, string>> = {};
    for (const f of info.fields) {
      if (f.secret) {
        if (cleared.has(f.key)) out[f.key] = "";
        else if (values[f.key]?.trim()) out[f.key] = values[f.key]!.trim();
      } else out[f.key] = values[f.key]?.trim() ?? "";
    }
    return out;
  }, [info.fields, values, cleared]);

  const secretSet = (k: FieldKey) => saved.secretsSet.includes(k) && !cleared.has(k);
  const hasCredentials = info.fields.filter((f) => f.required).every((f) => (f.secret ? secretSet(f.key) || !!values[f.key]?.trim() : !!values[f.key]?.trim()));

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    setModelsNote(null);
    try {
      const r = await aiApi.models(info.id, payload());
      if (r.models.length) {
        setModels(r.models);
        setModel((m) => m || r.models[0].id);
      }
      if (r.error) setModelsNote(r.error);
    } catch (e) {
      setModelsNote((e as Error).message);
    } finally {
      setLoadingModels(false);
    }
  }, [info.id, payload]);

  // Providers that list models per account: fetch once the credentials are there.
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (autoLoaded.current || !hasCredentials || (info.id !== "openai" && info.id !== "anthropic")) return;
    autoLoaded.current = true;
    void loadModels();
  }, [hasCredentials, info.id, loadModels]);

  useEffect(() => () => testAbort.current?.abort(), []);

  const runTest = async () => {
    testAbort.current?.abort();
    const ctl = new AbortController();
    testAbort.current = ctl;
    setTest({ state: "running" });
    try {
      const r = await aiApi.test(info.id, { model, values: payload() }, ctl.signal);
      setTest(r.ok ? { state: "ok", latencyMs: r.latencyMs, model: r.model } : { state: "error", message: r.error, kind: r.kind });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setTest({ state: "error", message: (e as Error).message, kind: "unknown" });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const next = await aiApi.save(info.id, { model: model.trim(), values: payload(), makeDefault });
      onSaved(next);
      setValues((v) => Object.fromEntries(Object.entries(v).filter(([k]) => !info.fields.find((f) => f.key === k)?.secret)));
      setCleared(new Set());
      toast.success(`${info.label} saved`, { description: makeDefault ? "Used for tailoring by default." : undefined });
    } catch (e) {
      toast.error("Couldn't save", { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const selectItems = [...models.map((m) => ({ value: m.id, label: m.label })), ...(info.freeformModel ? [{ value: CUSTOM, label: "Other model id…" }] : [])];

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div>
          <p className="text-sm text-muted-foreground">{info.description}</p>
          <a href={info.docsUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">
            Docs <ExternalLink className="size-3" />
          </a>
        </div>

        {info.fields.map((f) => (
          <div key={f.key} className="grid gap-1.5">
            <Label htmlFor={`f-${f.key}`} className="flex items-center gap-1.5">
              {f.secret && <KeyRound className="size-3 text-muted-foreground" />}
              {f.label}
              {f.required && <span className="text-muted-foreground">*</span>}
              {f.secret && secretSet(f.key) && (
                <span className="ml-auto flex items-center gap-2 text-[11px] font-normal text-success">
                  <Check className="size-3" /> Saved
                  <button
                    type="button"
                    className="text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
                    onClick={() => setCleared((c) => new Set(c).add(f.key))}
                  >
                    Remove
                  </button>
                </span>
              )}
            </Label>
            {f.multiline ? (
              <Textarea
                id={`f-${f.key}`}
                rows={4}
                className="max-h-40 font-mono text-xs"
                placeholder={f.secret && secretSet(f.key) ? "Saved. Paste a new one to replace it." : f.placeholder}
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                spellCheck={false}
              />
            ) : (
              <Input
                id={`f-${f.key}`}
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                className={cn(f.secret && "font-mono")}
                placeholder={f.secret && secretSet(f.key) ? "•••••••• saved. Type to replace." : f.placeholder}
                value={values[f.key] ?? ""}
                onChange={(e) => {
                  setValues((v) => ({ ...v, [f.key]: e.target.value }));
                  setTest({ state: "idle" });
                }}
              />
            )}
            {f.hint && <p className="text-[11px] text-muted-foreground">{f.hint}</p>}
          </div>
        ))}

        <div className="grid gap-1.5">
          <Label className="flex items-center">
            Model
            {(info.id === "openai" || info.id === "anthropic") && (
              <button
                type="button"
                className="ml-auto text-[11px] font-normal text-primary hover:underline disabled:opacity-50"
                disabled={!hasCredentials || loadingModels}
                onClick={() => void loadModels()}
              >
                {loadingModels ? "Loading…" : "Load my models"}
              </button>
            )}
          </Label>
          {selectItems.length > (info.freeformModel ? 1 : 0) && !customModel ? (
            <Select
              items={selectItems}
              value={models.some((m) => m.id === model) ? model : null}
              onValueChange={(v) => {
                if (v === CUSTOM) {
                  setCustomModel(true);
                  setModel("");
                } else setModel(String(v));
                setTest({ state: "idle" });
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a model" />
              </SelectTrigger>
              <SelectContent>
                {selectItems.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                    {m.value !== CUSTOM && m.label !== m.value && <span className="ml-1 font-mono text-[11px] text-muted-foreground">{m.value}</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="flex gap-2">
              <Input
                className="font-mono"
                spellCheck={false}
                placeholder={info.id === "vertex" ? "gemini-…" : info.id === "openai" ? "gpt-…" : "model id"}
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setTest({ state: "idle" });
                }}
              />
              {models.length > 0 && (
                <Button type="button" variant="outline" onClick={() => setCustomModel(false)}>
                  Pick from list
                </Button>
              )}
            </div>
          )}
          {modelsNote && <p className="text-[11px] text-warning">{modelsNote}</p>}
        </div>

        <label className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
          <span>
            <span className="block text-sm font-medium">Use by default</span>
            <span className="block text-xs text-muted-foreground">Preselected when you tailor a resume. You can still switch per run.</span>
          </span>
          <Switch checked={makeDefault} onCheckedChange={(v) => setMakeDefault(!!v)} />
        </label>

        {test.state === "ok" && (
          <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm">
            <Check className="size-4 text-success" />
            Connected. {test.model} answered in {(test.latencyMs / 1000).toFixed(1)} s.
          </div>
        )}
        {test.state === "error" && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span className="min-w-0 break-words">
              {test.message}
              {test.kind === "auth" && (
                <span className="block text-xs text-muted-foreground">Check the key, or for Claude Code run `claude` once in a terminal to log in.</span>
              )}
            </span>
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
        <Button type="button" variant="outline" disabled={test.state === "running" || !model.trim() || !hasCredentials} onClick={() => void runTest()}>
          {test.state === "running" ? <Loader2 className="animate-spin" /> : <PlugZap />}
          {test.state === "running" ? "Testing…" : "Test connection"}
        </Button>
        <Button type="button" disabled={saving || !model.trim()} onClick={() => void save()}>
          {saving && <Loader2 className="animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}
