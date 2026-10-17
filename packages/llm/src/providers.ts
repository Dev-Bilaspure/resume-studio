import { createAnthropic } from "@ai-sdk/anthropic";
import { createVertex } from "@ai-sdk/google-vertex";
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, NoObjectGeneratedError, NoOutputGeneratedError, Output, RetryError, generateText, type LanguageModel } from "ai";
import { createClaudeCode, isAuthenticationError, isTimeoutError } from "ai-sdk-provider-claude-code";
import { LLMError, type GenerateRequest, type GenerateResult, type LLM, type ProviderConfig, type ProviderId } from "./types.ts";

/** Claude Code's model aliases, or a full model id. */
const CLAUDE_CODE_MODEL = /^(opus|sonnet|haiku|fable|claude-[a-z0-9.-]+)(\[1m\])?$/;

/**
 * The model that actually answered, from Claude Code's per-model usage. It also runs a small model
 * (Haiku) for its own housekeeping; the answer comes from the other one, unless Haiku was asked for.
 */
function claudeCodeModel(metadata: unknown, requested: string): string | undefined {
  const usage = (metadata as { "claude-code"?: { modelUsage?: Record<string, { outputTokens?: number }> } } | undefined)?.["claude-code"]?.modelUsage;
  if (!usage) return undefined;
  const models = Object.keys(usage);
  const main = models.filter((m) => !/haiku/.test(m));
  if (/haiku/.test(requested) || !main.length) return models.find((m) => /haiku/.test(m)) ?? models[0];
  return main.sort((a, b) => (usage[b].outputTokens ?? 0) - (usage[a].outputTokens ?? 0))[0];
}

/** The AI SDK model object for a provider configuration. Credentials come from the config only. */
export function languageModel(config: ProviderConfig): LanguageModel {
  switch (config.provider) {
    case "openai":
      if (!config.apiKey) throw new LLMError("auth", "OpenAI needs an API key", false, "openai");
      return createOpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, organization: config.organization, project: config.openaiProject })(config.model);
    case "anthropic":
      if (!config.apiKey) throw new LLMError("auth", "Anthropic needs an API key", false, "anthropic");
      return createAnthropic({ apiKey: config.apiKey, baseURL: config.baseURL })(config.model);
    case "vertex": {
      const v = config.vertex;
      if (!v?.project || !v.location) throw new LLMError("auth", "Vertex AI needs a project ID and a region", false, "vertex");
      let credentials: Record<string, string> | undefined;
      if (v.credentialsJson) {
        try {
          credentials = JSON.parse(v.credentialsJson);
        } catch {
          throw new LLMError("auth", "The service-account JSON isn't valid JSON", false, "vertex");
        }
      }
      return createVertex({ project: v.project, location: v.location, ...(credentials ? { googleAuthOptions: { credentials } } : {}) })(config.model);
    }
    case "claude-code":
      // Claude Code runs an unknown model name on its default model without saying so: refuse it here.
      if (!CLAUDE_CODE_MODEL.test(config.model))
        throw new LLMError("unavailable", `"${config.model}" isn't a Claude Code model. Use opus, sonnet, haiku, fable or a full claude-… model id.`, false, "claude-code");
      // The local Claude Code login (Pro/Max subscription). Isolated from your own Claude Code setup:
      // no tools, no CLAUDE.md/settings/hooks/plugins, and it can't touch files.
      return createClaudeCode({
        defaultSettings: {
          tools: [],
          settingSources: [],
          permissionMode: "default",
          maxTurns: 4,
          // Each call is its own conversation: nothing is saved to your Claude Code session history.
          persistSession: false,
          logger: false, // its internal warnings aren't actionable for callers
          ...(config.claudeCodePath ? { pathToClaudeCodeExecutable: config.claudeCodePath } : {}),
        },
      })(config.model);
  }
}

/** Recent Claude models reject sampling parameters; OpenAI reasoning models do too. */
function acceptsTemperature(config: ProviderConfig) {
  if (config.provider === "claude-code" || config.provider === "anthropic") return false;
  if (config.provider === "openai" && /^(o\d|gpt-5)/i.test(config.model)) return false;
  return true;
}

export function toLLMError(e: unknown, provider: ProviderId): LLMError {
  if (e instanceof LLMError) return e;
  // "Failed after 3 attempts": classify what actually went wrong.
  if (RetryError.isInstance(e) && e.lastError) return toLLMError(e.lastError, provider);
  if (e instanceof NoObjectGeneratedError || e instanceof NoOutputGeneratedError) {
    return new LLMError("invalid_output", `The model's answer didn't match the expected format: ${(e as Error).message}`, true, provider, e);
  }
  const err = e as Error & { name?: string };
  if (err?.name === "AbortError") return new LLMError("aborted", "Cancelled", false, provider, e);
  if (provider === "claude-code") {
    if (isAuthenticationError(e)) return new LLMError("auth", "Claude Code isn't logged in. Run `claude` in a terminal and log in.", false, provider, e);
    if (isTimeoutError(e)) return new LLMError("timeout", "Claude Code took too long to answer", true, provider, e);
    if (/ENOENT|not found|spawn/i.test(err?.message ?? "")) return new LLMError("unavailable", "Claude Code isn't installed or can't be started", false, provider, e);
    if (/usage limit|rate limit|limit reached|session limit|hit your .*limit/i.test(err?.message ?? "")) {
      // Claude Code says when it resets ("resets 2:40am (Asia/Calcutta)"): pass that on.
      const resets = /resets? ([^·\n]+)/i.exec(err?.message ?? "")?.[1]?.trim();
      return new LLMError("rate_limit", `Your Claude subscription's usage limit was reached${resets ? `. It resets ${resets}` : ""}.`, false, provider, e);
    }
  }
  if (APICallError.isInstance(e)) {
    const s = e.statusCode ?? 0;
    if (s === 401 || s === 403) return new LLMError("auth", `Authentication failed (${s}): check the credentials`, false, provider, e);
    if (s === 429) return new LLMError("rate_limit", "Rate limited or out of quota", true, provider, e);
    if (s === 404) return new LLMError("unavailable", `Model not found or not available to this account: ${e.message}`, false, provider, e);
    if (s >= 500) return new LLMError("unavailable", `The provider had an error (${s})`, true, provider, e);
    return new LLMError("unknown", e.message, false, provider, e);
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network/i.test(err?.message ?? "")) return new LLMError("network", "Network error reaching the provider", true, provider, e);
  if (/could not load the default credentials|invalid_grant|unauthenticated/i.test(err?.message ?? "")) {
    return new LLMError("auth", "Google credentials are missing or expired. Run `gcloud auth application-default login`, or paste a service-account JSON.", false, provider, e);
  }
  return new LLMError("unknown", err?.message ?? String(e), false, provider, e);
}

export function createLLM(config: ProviderConfig): LLM {
  // Validates the config now (unknown model, missing key) rather than on the first call.
  const shared = languageModel(config);
  // Claude Code's model object remembers its last session and resumes it on the next call, so calls
  // through one object would share a conversation (a fact-check that remembers writing the edits; one
  // evaluation case that sees the last). A fresh object per call keeps every call independent.
  const modelFor = () => (config.provider === "claude-code" ? languageModel(config) : shared);
  return {
    provider: config.provider,
    model: config.model,
    async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
      const started = Date.now();
      const timeout = AbortSignal.timeout(req.timeoutMs ?? 5 * 60_000);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      try {
        const result = await generateText({
          model: modelFor(),
          system: req.system,
          ...(typeof req.prompt === "string" ? { prompt: req.prompt } : { messages: req.prompt }),
          output: Output.object({ schema: req.schema, name: req.schemaName, description: req.schemaDescription }),
          // Claude Code takes no output cap (it warns on every call if given one).
          ...(config.provider === "claude-code" ? {} : { maxOutputTokens: req.maxOutputTokens ?? 16_000 }),
          ...(req.temperature !== undefined && acceptsTemperature(config) ? { temperature: req.temperature } : {}),
          // Transient errors (429, 5xx, network) with backoff. Claude Code retries API errors itself, and
          // its limit errors don't clear in seconds: no second layer of retries there.
          maxRetries: config.provider === "claude-code" ? 0 : 2,
          abortSignal: signal,
        });
        const data = result.output as T;
        let actual = result.response.modelId || config.model;
        if (config.provider === "claude-code") {
          actual = claudeCodeModel(result.providerMetadata, config.model) ?? config.model;
          // A full id (not an alias) that ran as something else was swapped for the default: say so.
          if (config.model.startsWith("claude-") && !actual.startsWith(config.model.replace(/\[1m\]$/, "")))
            throw new LLMError("unavailable", `Claude Code ran ${actual} instead of ${config.model}. Check the model id.`, false, config.provider);
        }
        return {
          data,
          usage: {
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
            totalTokens: result.usage.totalTokens ?? (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
          },
          provider: config.provider,
          model: actual,
          durationMs: Date.now() - started,
        };
      } catch (e) {
        if (timeout.aborted && !req.signal?.aborted) throw new LLMError("timeout", `No answer within ${Math.round((req.timeoutMs ?? 300_000) / 1000)} s`, true, config.provider, e);
        throw toLLMError(e, config.provider);
      }
    },
  };
}
