import type { z } from "zod";

export type ProviderId = "claude-code" | "openai" | "anthropic" | "vertex";

/** Everything needed to talk to one provider. Secrets are passed in; this package never stores them. */
export interface ProviderConfig {
  provider: ProviderId;
  /** Model id or alias ("opus" for Claude Code, "claude-opus-5-5", "gemini-…", an OpenAI model id). */
  model: string;
  /** OpenAI and Anthropic. */
  apiKey?: string;
  /** OpenAI-compatible endpoints (Azure, proxies) and Anthropic proxies. */
  baseURL?: string;
  /** OpenAI organization / project. */
  organization?: string;
  openaiProject?: string;
  /** Google Vertex AI. Without credentialsJson, Application Default Credentials are used (gcloud login). */
  vertex?: { project: string; location: string; credentialsJson?: string };
  /** Claude Code: use this `claude` binary instead of the one bundled with the Agent SDK. */
  claudeCodePath?: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest<T> {
  /** Instructions: who the model is, the rules it follows. */
  system?: string;
  /** The task, or a conversation (for repair rounds that show the model its previous answer). */
  prompt: string | Message[];
  /** Shape of the answer. Validated; a non-conforming answer is an `invalid_output` error. */
  schema: z.ZodType<T>;
  /** Shown to providers that support named schemas. */
  schemaName?: string;
  schemaDescription?: string;
  maxOutputTokens?: number;
  /** Ignored for models that don't accept it (recent Claude models reject sampling parameters). */
  temperature?: number;
  signal?: AbortSignal;
  /** Per attempt. Default 5 minutes: long resumes with careful reasoning take time. */
  timeoutMs?: number;
  /** Label for logs and usage accounting, e.g. "analyze-job". */
  step?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface GenerateResult<T> {
  data: T;
  usage: Usage;
  provider: ProviderId;
  model: string;
  durationMs: number;
}

export interface LLM {
  readonly provider: ProviderId;
  readonly model: string;
  generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>>;
}

export type LLMErrorKind =
  | "auth" // bad or missing credentials, not logged in
  | "rate_limit" // 429 / quota / subscription limit
  | "invalid_output" // the model's answer didn't match the schema
  | "unavailable" // provider down, model not found, CLI missing
  | "network"
  | "timeout"
  | "aborted"
  | "refused" // the model declined
  | "unknown";

export class LLMError extends Error {
  kind: LLMErrorKind;
  /** Worth retrying later (rate limit, timeout, provider error), as opposed to fixing settings. */
  retryable: boolean;
  provider: ProviderId;

  constructor(kind: LLMErrorKind, message: string, retryable: boolean, provider: ProviderId, cause?: unknown) {
    super(message, { cause });
    this.name = "LLMError";
    this.kind = kind;
    this.retryable = retryable;
    this.provider = provider;
  }
}
