import assert from "node:assert/strict";
import { test } from "node:test";
import { APICallError, RetryError } from "ai";
import { toLLMError } from "./providers.ts";
import { LLMError } from "./types.ts";

const apiError = (message: string, statusCode: number) =>
  new APICallError({ message, url: "https://example.test", requestBodyValues: {}, statusCode, isRetryable: true });

test("a Claude subscription limit is a rate limit, with the reset time, and isn't retried", () => {
  const e = toLLMError(apiError("You've hit your session limit · resets 2:40am (Asia/Calcutta)", 429), "claude-code");
  assert.equal(e.kind, "rate_limit");
  assert.equal(e.retryable, false);
  assert.match(e.message, /resets 2:40am \(Asia\/Calcutta\)/);
});

test("retry wrappers are unwrapped to the error that caused them", () => {
  const last = apiError("You've hit your session limit · resets 2:40am (Asia/Calcutta)", 429);
  const wrapped = new RetryError({ message: `Failed after 3 attempts. Last error: ${last.message}`, reason: "maxRetriesExceeded", errors: [last, last, last] });
  assert.equal(toLLMError(wrapped, "claude-code").kind, "rate_limit");
});

test("HTTP statuses map to kinds", () => {
  assert.equal(toLLMError(apiError("bad key", 401), "openai").kind, "auth");
  assert.equal(toLLMError(apiError("slow down", 429), "openai").kind, "rate_limit");
  assert.equal(toLLMError(apiError("no such model", 404), "anthropic").kind, "unavailable");
  assert.equal(toLLMError(apiError("boom", 503), "vertex").retryable, true);
});

test("an LLMError passes through unchanged", () => {
  const e = new LLMError("auth", "x", false, "openai");
  assert.equal(toLLMError(e, "openai"), e);
});
