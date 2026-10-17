// Provider credentials from environment variables, for services (tailor-server, tailor-mcp) that don't
// have a settings screen. Node-only: reads a service-account file when one is named.
import { readFileSync } from "node:fs";
import type { ProviderConfig, ProviderId } from "./types.ts";

export type ProviderCredentials = Omit<ProviderConfig, "model">;

/**
 * The providers the environment has credentials for, in a stable order (Anthropic, OpenAI, Vertex AI,
 * then Claude Code when allowed). Claude Code uses the local CLI's login, so it's only included when the
 * caller allows it (a tool on your own machine) or TAILOR_ENABLE_CLAUDE_CODE=1.
 */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env, opts: { claudeCode?: boolean } = {}): ProviderCredentials[] {
  const out: ProviderCredentials[] = [];
  if (env.ANTHROPIC_API_KEY) out.push({ provider: "anthropic", apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL });
  if (env.OPENAI_API_KEY) out.push({ provider: "openai", apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL, organization: env.OPENAI_ORGANIZATION, openaiProject: env.OPENAI_PROJECT });
  if (env.GOOGLE_VERTEX_PROJECT && env.GOOGLE_VERTEX_LOCATION) {
    const file = env.GOOGLE_APPLICATION_CREDENTIALS;
    out.push({ provider: "vertex", vertex: { project: env.GOOGLE_VERTEX_PROJECT, location: env.GOOGLE_VERTEX_LOCATION, credentialsJson: file ? readFileSync(file, "utf8") : undefined } });
  }
  if (env.TAILOR_ENABLE_CLAUDE_CODE === "1" || opts.claudeCode) out.push({ provider: "claude-code", claudeCodePath: env.CLAUDE_CODE_PATH });
  return out;
}

/** Default model per provider: TAILOR_<PROVIDER>_MODEL, or TAILOR_MODEL for TAILOR_PROVIDER. */
export function defaultModelsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<Record<ProviderId, string>> {
  return {
    anthropic: env.TAILOR_ANTHROPIC_MODEL ?? "claude-opus-5-5",
    openai: env.TAILOR_OPENAI_MODEL,
    vertex: env.TAILOR_VERTEX_MODEL,
    "claude-code": env.TAILOR_CLAUDE_CODE_MODEL ?? "opus",
    ...(env.TAILOR_PROVIDER && env.TAILOR_MODEL ? { [env.TAILOR_PROVIDER]: env.TAILOR_MODEL } : {}),
  };
}
