// Server configuration, from the environment. Provider credentials live here (never in requests), so a
// client can pick a provider and a model but can't make the server call anything it wasn't set up for.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProviderConfig, ProviderId } from "@resume-studio/llm";

export interface ServerConfig {
  host: string;
  port: number;
  /** Bearer token clients must send. Required unless the server only listens on loopback. */
  apiKey?: string;
  dataDir: string;
  /** Providers this server can use, with credentials; the first is the default. */
  providers: Omit<ProviderConfig, "model">[];
  defaultProvider?: ProviderId;
  /** Default model per provider (requests may name another). */
  defaultModels: Partial<Record<ProviderId, string>>;
  /** Largest request body, bytes (sources + assets). */
  maxBodyBytes: number;
  /** Parallel tailoring runs; more wait in a queue. */
  concurrency: number;
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|::1)$/;

export function isLoopback(host: string) {
  return LOOPBACK.test(host);
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const providers: Omit<ProviderConfig, "model">[] = [];
  if (env.ANTHROPIC_API_KEY) providers.push({ provider: "anthropic", apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL });
  if (env.OPENAI_API_KEY) providers.push({ provider: "openai", apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL, organization: env.OPENAI_ORGANIZATION, openaiProject: env.OPENAI_PROJECT });
  if (env.GOOGLE_VERTEX_PROJECT && env.GOOGLE_VERTEX_LOCATION) {
    const file = env.GOOGLE_APPLICATION_CREDENTIALS;
    providers.push({
      provider: "vertex",
      vertex: { project: env.GOOGLE_VERTEX_PROJECT, location: env.GOOGLE_VERTEX_LOCATION, credentialsJson: file ? readFileSync(file, "utf8") : undefined },
    });
  }
  // Claude Code uses the local CLI's login: only on a machine where someone has logged in, by choice.
  if (env.TAILOR_ENABLE_CLAUDE_CODE === "1") providers.push({ provider: "claude-code", claudeCodePath: env.CLAUDE_CODE_PATH });

  const host = env.HOST ?? "127.0.0.1";
  const config: ServerConfig = {
    host,
    port: Number(env.PORT ?? 8787),
    apiKey: env.TAILOR_API_KEY || undefined,
    dataDir: resolve(env.TAILOR_DATA_DIR ?? "./tailor-data"),
    providers,
    defaultProvider: (env.TAILOR_PROVIDER as ProviderId | undefined) ?? providers[0]?.provider,
    defaultModels: {
      anthropic: env.TAILOR_ANTHROPIC_MODEL ?? "claude-opus-5-5",
      openai: env.TAILOR_OPENAI_MODEL,
      vertex: env.TAILOR_VERTEX_MODEL,
      "claude-code": env.TAILOR_CLAUDE_CODE_MODEL ?? "opus",
      ...(env.TAILOR_PROVIDER && env.TAILOR_MODEL ? { [env.TAILOR_PROVIDER]: env.TAILOR_MODEL } : {}),
    },
    maxBodyBytes: Number(env.TAILOR_MAX_BODY_BYTES ?? 10 * 1024 * 1024),
    concurrency: Number(env.TAILOR_CONCURRENCY ?? 2),
  };
  checkConfig(config);
  return config;
}

export function checkConfig(c: ServerConfig) {
  if (!c.apiKey && !isLoopback(c.host)) throw new Error(`Listening on ${c.host} needs TAILOR_API_KEY: without it anyone who can reach the server could use your provider credentials.`);
  if (!c.providers.length) throw new Error("No provider is configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_VERTEX_PROJECT + GOOGLE_VERTEX_LOCATION, or TAILOR_ENABLE_CLAUDE_CODE=1.");
}
