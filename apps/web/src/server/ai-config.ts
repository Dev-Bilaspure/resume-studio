import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROVIDERS, type ProviderConfig, type ProviderField, type ProviderId } from "@resume-studio/llm";
import { STATE_DIR } from "./config";
import { atomicWrite, HttpError } from "./fsutil";
import { run } from "./run";

// AI provider settings. Non-secret values (model, project, region, base URL) live in
// .resume-studio/ai.json; secrets (API keys, service-account JSON) live in the macOS Keychain under the
// service "resume-studio", and never reach the browser after they're saved.

const FILE = join(STATE_DIR, "ai.json");
const KEYCHAIN_SERVICE = "resume-studio";

type FieldKey = ProviderField["key"];

interface StoredProvider {
  model?: string;
  /** Non-secret field values. */
  values?: Partial<Record<FieldKey, string>>;
  /** Which secret fields have a value in the Keychain. */
  secrets?: FieldKey[];
}

interface Stored {
  defaultProvider?: ProviderId;
  providers: Partial<Record<ProviderId, StoredProvider>>;
}

async function readStored(): Promise<Stored> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as Stored;
  } catch {
    return { providers: {} };
  }
}

async function writeStored(s: Stored) {
  await atomicWrite(FILE, JSON.stringify(s, null, 2) + "\n");
}

// ---- Keychain (macOS `security`), with a clear error elsewhere --------------------------------------------

const account = (provider: ProviderId, key: FieldKey) => `${provider}:${key}`;

async function keychainSet(provider: ProviderId, key: FieldKey, value: string) {
  if (process.platform !== "darwin") throw new HttpError(501, "Saving secrets needs the macOS Keychain");
  // -U updates an existing item. `security` takes the secret as an argument (it's briefly visible to
  // your own user's process list while the command runs, never to other users), and never on disk.
  const r = await run("/usr/bin/security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account(provider, key), "-w", value], { timeoutMs: 10_000 });
  if (r.code !== 0) throw new HttpError(500, `Couldn't save to the Keychain: ${r.stderr.trim()}`);
}

async function keychainGet(provider: ProviderId, key: FieldKey): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const r = await run("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account(provider, key), "-w"], { timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.replace(/\n$/, "") : null;
}

async function keychainDelete(provider: ProviderId, key: FieldKey) {
  if (process.platform !== "darwin") return;
  await run("/usr/bin/security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account(provider, key)], { timeoutMs: 10_000 });
}

// ---- Public view and updates ------------------------------------------------------------------------------

export interface ProviderSettingsView {
  id: ProviderId;
  model: string;
  /** Non-secret values as saved; secret fields are reported as set/unset only. */
  values: Partial<Record<FieldKey, string>>;
  secretsSet: FieldKey[];
  /** All required fields are filled. */
  configured: boolean;
}

export interface AiSettingsView {
  defaultProvider: ProviderId | null;
  providers: ProviderSettingsView[];
}

function isConfigured(id: ProviderId, p: StoredProvider | undefined): boolean {
  const info = PROVIDERS.find((x) => x.id === id)!;
  const model = p?.model || info.defaultModel;
  if (!model) return false;
  return info.fields.filter((f) => f.required).every((f) => (f.secret ? p?.secrets?.includes(f.key) : !!p?.values?.[f.key]?.trim()));
}

export async function getAiSettings(): Promise<AiSettingsView> {
  const s = await readStored();
  return {
    // With nothing chosen, runs use Claude Code (it needs no setup): say so.
    defaultProvider: s.defaultProvider ?? "claude-code",
    providers: PROVIDERS.map((info) => {
      const p = s.providers[info.id];
      return {
        id: info.id,
        model: p?.model || info.defaultModel,
        values: p?.values ?? {},
        secretsSet: p?.secrets ?? [],
        configured: isConfigured(info.id, p),
      };
    }),
  };
}

/**
 * Saves a provider's settings. `values` holds every field; a secret field that's absent or undefined
 * keeps its saved value, an empty string removes it.
 */
export async function saveProvider(id: ProviderId, update: { model?: string; values: Partial<Record<FieldKey, string>>; makeDefault?: boolean }) {
  const info = PROVIDERS.find((x) => x.id === id);
  if (!info) throw new HttpError(400, `Unknown provider ${id}`);
  const s = await readStored();
  const p: StoredProvider = s.providers[id] ?? {};
  const values = { ...(p.values ?? {}) };
  const secrets = new Set(p.secrets ?? []);
  for (const field of info.fields) {
    const v = update.values[field.key];
    if (v === undefined) continue;
    if (field.secret) {
      if (v.trim()) {
        await keychainSet(id, field.key, v.trim());
        secrets.add(field.key);
      } else {
        await keychainDelete(id, field.key);
        secrets.delete(field.key);
      }
    } else if (v.trim()) values[field.key] = v.trim();
    else delete values[field.key];
  }
  s.providers[id] = { model: update.model?.trim() || p.model, values, secrets: [...secrets] };
  if (update.makeDefault || !s.defaultProvider) s.defaultProvider = id;
  await writeStored(s);
  return getAiSettings();
}

export async function setDefaultProvider(id: ProviderId) {
  const s = await readStored();
  s.defaultProvider = id;
  await writeStored(s);
}

/** A full provider config, secrets included (server-side only). Overrides win (e.g. unsaved test values). */
export async function resolveProvider(id?: ProviderId, overrides?: { model?: string; values?: Partial<Record<FieldKey, string>> }): Promise<ProviderConfig> {
  const s = await readStored();
  const provider = id ?? s.defaultProvider ?? "claude-code";
  const info = PROVIDERS.find((x) => x.id === provider);
  if (!info) throw new HttpError(400, `Unknown provider ${provider}`);
  const p = s.providers[provider];
  const value = async (key: FieldKey): Promise<string | undefined> => {
    const o = overrides?.values?.[key];
    if (o !== undefined && o !== "") return o;
    const field = info.fields.find((f) => f.key === key);
    if (field?.secret) return p?.secrets?.includes(key) ? ((await keychainGet(provider, key)) ?? undefined) : undefined;
    return p?.values?.[key];
  };
  const vertexProject = await value("vertexProject");
  const vertexLocation = await value("vertexLocation");
  return {
    provider,
    model: overrides?.model?.trim() || p?.model || info.defaultModel,
    apiKey: await value("apiKey"),
    baseURL: await value("baseURL"),
    organization: await value("organization"),
    openaiProject: await value("openaiProject"),
    claudeCodePath: await value("claudeCodePath"),
    vertex: vertexProject || vertexLocation ? { project: vertexProject ?? "", location: vertexLocation ?? "", credentialsJson: await value("vertexCredentialsJson") } : undefined,
  };
}
