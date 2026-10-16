import { z } from "zod";
import { createLLM } from "./providers.ts";
import { LLMError, type ProviderConfig, type ProviderId } from "./types.ts";

export interface ProviderField {
  key: "apiKey" | "baseURL" | "organization" | "openaiProject" | "vertexProject" | "vertexLocation" | "vertexCredentialsJson" | "claudeCodePath";
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  multiline?: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  description: string;
  fields: ProviderField[];
  /** Suggested models; listModels() returns the account's actual list where the provider has one. */
  models: { id: string; label: string }[];
  defaultModel: string;
  /** Model ids can be typed freely (the list isn't exhaustive). */
  freeformModel: boolean;
  docsUrl: string;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "claude-code",
    label: "Claude Code (your subscription)",
    description: "Uses the Claude Code login on this Mac (Pro/Max plan). No API key; usage counts toward your plan.",
    fields: [{ key: "claudeCodePath", label: "claude binary", placeholder: "bundled (leave empty)", hint: "Optional: path to your own claude executable." }],
    models: [
      { id: "opus", label: "Opus (latest)" },
      { id: "fable", label: "Fable (most capable)" },
      { id: "sonnet", label: "Sonnet (faster)" },
    ],
    defaultModel: "opus",
    freeformModel: true,
    docsUrl: "https://code.claude.com/docs",
  },
  {
    id: "anthropic",
    label: "Anthropic API",
    description: "Claude through the Anthropic API, billed to your API account.",
    fields: [
      { key: "apiKey", label: "API key", secret: true, required: true, placeholder: "sk-ant-…" },
      { key: "baseURL", label: "Base URL", placeholder: "https://api.anthropic.com/v1 (default)", hint: "Only for proxies." },
    ],
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    ],
    defaultModel: "claude-opus-5-5",
    freeformModel: true,
    docsUrl: "https://platform.claude.com/docs",
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "OpenAI models through your API key. The model list comes from your account.",
    fields: [
      { key: "apiKey", label: "API key", secret: true, required: true, placeholder: "sk-…" },
      { key: "organization", label: "Organization ID", placeholder: "optional" },
      { key: "openaiProject", label: "Project ID", placeholder: "optional" },
      { key: "baseURL", label: "Base URL", placeholder: "https://api.openai.com/v1 (default)", hint: "For Azure OpenAI or compatible endpoints." },
    ],
    models: [],
    defaultModel: "",
    freeformModel: true,
    docsUrl: "https://platform.openai.com/docs",
  },
  {
    id: "vertex",
    label: "Google Vertex AI",
    description: "Gemini on Vertex AI in your Google Cloud project.",
    fields: [
      { key: "vertexProject", label: "Project ID", required: true, placeholder: "my-gcp-project" },
      { key: "vertexLocation", label: "Region", required: true, placeholder: "us-central1" },
      {
        key: "vertexCredentialsJson",
        label: "Service-account JSON",
        secret: true,
        multiline: true,
        placeholder: "optional: paste the key file's contents",
        hint: "Leave empty to use `gcloud auth application-default login`.",
      },
    ],
    models: [],
    defaultModel: "",
    freeformModel: true,
    docsUrl: "https://cloud.google.com/vertex-ai/generative-ai/docs",
  },
];

export function providerInfo(id: ProviderId): ProviderInfo {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown provider ${id}`);
  return p;
}

/** Models available to this account, where the provider can list them; otherwise the suggestions. */
export async function listModels(config: Omit<ProviderConfig, "model">, signal?: AbortSignal): Promise<{ id: string; label: string }[]> {
  const info = providerInfo(config.provider);
  try {
    if (config.provider === "openai" && config.apiKey) {
      const res = await fetch(`${(config.baseURL ?? "https://api.openai.com/v1").replace(/\/$/, "")}/models`, {
        headers: { Authorization: `Bearer ${config.apiKey}`, ...(config.organization ? { "OpenAI-Organization": config.organization } : {}) },
        signal,
      });
      if (!res.ok) throw new LLMError(res.status === 401 ? "auth" : "unavailable", `Listing models failed (${res.status})`, false, "openai");
      const data = (await res.json()) as { data: { id: string; created?: number }[] };
      // Chat-capable models, newest first.
      return data.data
        .filter((m) => /^(gpt|o\d|chatgpt)/i.test(m.id) && !/(audio|realtime|transcribe|tts|image|search|embedding|instruct)/i.test(m.id))
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .map((m) => ({ id: m.id, label: m.id }));
    }
    if (config.provider === "anthropic" && config.apiKey) {
      const res = await fetch(`${(config.baseURL ?? "https://api.anthropic.com/v1").replace(/\/$/, "")}/models?limit=100`, {
        headers: { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
        signal,
      });
      if (!res.ok) throw new LLMError(res.status === 401 ? "auth" : "unavailable", `Listing models failed (${res.status})`, false, "anthropic");
      const data = (await res.json()) as { data: { id: string; display_name?: string }[] };
      return data.data.map((m) => ({ id: m.id, label: m.display_name ?? m.id }));
    }
  } catch (e) {
    if (e instanceof LLMError) throw e;
    throw new LLMError("network", `Couldn't list models: ${(e as Error).message}`, true, config.provider, e);
  }
  return info.models;
}

/** One tiny structured request: proves the credentials, the model id and structured output all work. */
export async function testConnection(config: ProviderConfig, signal?: AbortSignal): Promise<{ ok: true; latencyMs: number; model: string }> {
  if (!config.model) throw new LLMError("unavailable", "Choose a model first", false, config.provider);
  const llm = createLLM(config);
  const res = await llm.generate({
    system: "You are a connectivity check. Answer exactly as instructed.",
    prompt: 'Return {"ok": true, "word": "ready"}.',
    schema: z.object({ ok: z.boolean(), word: z.string() }),
    schemaName: "connection_check",
    maxOutputTokens: 2_000,
    timeoutMs: 120_000,
    signal,
    step: "test-connection",
  });
  if (!res.data.ok) throw new LLMError("invalid_output", "The model answered, but not as instructed", false, config.provider);
  return { ok: true, latencyMs: res.durationMs, model: config.model };
}
