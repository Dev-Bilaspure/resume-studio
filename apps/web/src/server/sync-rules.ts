// What sync may touch, and what it must never upload. Pure, so it can be unit tested.
import { isJunk } from "./junk.ts";

/**
 * The paths that are synced, relative to the app's root. Everything else (the app's code, build files,
 * keys) is invisible to sync: never uploaded, and never written by a download.
 */
export function isSynced(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || p === ".git" || isJunk(p) || p.endsWith(".lock"))) return false;
  if (parts.at(-1) === "secrets.json") return false;
  if (parts[0] === "resumes") return parts.length >= 2;
  if (path === ".resume-studio/ai.json") return true;
  return /^\.resume-studio\/tailor\/sessions\/[A-Za-z0-9-]+\.json$/.test(path);
}

const SECRETS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "an Anthropic API key"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/, "an OpenAI API key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/, "a private key"],
  [/"private_key"\s*:\s*"-----BEGIN/, "a service-account key"],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/, "a GitHub token"],
];

/** What kind of secret the text seems to contain, or null. */
export function findSecret(text: string): string | null {
  return SECRETS.find(([re]) => re.test(text))?.[1] ?? null;
}
