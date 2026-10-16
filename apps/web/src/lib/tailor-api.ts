"use client";

import type { ProviderField, ProviderId, ProviderInfo } from "@resume-studio/llm";
import type { Answer, EditOp, Fact, JobInput, ResumeDoc, Session, TailorOptions } from "@resume-studio/tailor";
import { ApiError } from "./api";
import type { ResumeMeta } from "./types";

export type { ProviderField, ProviderId, ProviderInfo };

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`, data as Record<string, unknown>);
  return data as T;
}

const enc = encodeURIComponent;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

// ---- AI providers ---------------------------------------------------------------------------------------

export type FieldKey = ProviderField["key"];

export interface ProviderSettings {
  id: ProviderId;
  model: string;
  values: Partial<Record<FieldKey, string>>;
  secretsSet: FieldKey[];
  configured: boolean;
}

export interface AiSettings {
  defaultProvider: ProviderId | null;
  providers: ProviderSettings[];
}

export const aiApi = {
  get: () => req<{ catalog: ProviderInfo[]; settings: AiSettings }>("/api/ai/settings"),
  setDefault: (defaultProvider: ProviderId) => req<AiSettings>("/api/ai/settings", { method: "PUT", body: JSON.stringify({ defaultProvider }) }),
  save: (id: ProviderId, body: { model?: string; values: Partial<Record<FieldKey, string>>; makeDefault?: boolean }) =>
    req<AiSettings>(`/api/ai/providers/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  test: (id: ProviderId, body: { model?: string; values?: Partial<Record<FieldKey, string>> }, signal?: AbortSignal) =>
    req<{ ok: true; latencyMs: number; model: string } | { ok: false; kind: string; error: string }>(`/api/ai/providers/${id}/test`, { ...post(body), signal }),
  models: (id: ProviderId, values?: Partial<Record<FieldKey, string>>) =>
    req<{ models: { id: string; label: string }[]; error?: string }>(`/api/ai/providers/${id}/models`, post({ values })),
};

// ---- Tailoring --------------------------------------------------------------------------------------------

/** A session as the API returns it (no raw source or draft files). */
export type SessionView = Omit<Session, "source" | "draft"> & { running: boolean };

export type SessionSummary = Pick<Session, "id" | "status" | "createdAt" | "updatedAt" | "job" | "context">;

export interface StartBody {
  resumeId: string;
  job: JobInput;
  options?: TailorOptions;
  provider?: ProviderId;
  model?: string;
}

export interface PreviewResult {
  url: string | null;
  pages: number | null;
  atsScore: number | null;
  errors: string[];
}

const s = (id: string) => `/api/tailor/sessions/${enc(id)}`;

export const tailorApi = {
  list: (resumeId?: string) => req<{ sessions: SessionSummary[] }>(`/api/tailor/sessions${resumeId ? `?resumeId=${enc(resumeId)}` : ""}`),
  start: (body: StartBody) => req<{ id: string }>("/api/tailor/sessions", post(body)),
  get: (id: string) => req<SessionView>(s(id)),
  answer: (id: string, answers: Answer[]) => req<void>(`${s(id)}/answers`, post({ answers })),
  retry: (id: string) => req<void>(`${s(id)}/retry`, post({})),
  cancel: (id: string) => req<void>(`${s(id)}/cancel`, post({})),
  preview: (id: string, accepted: string[], signal?: AbortSignal) => req<PreviewResult>(`${s(id)}/preview`, { ...post({ accepted }), signal }),
  finalize: (id: string, accepted: string[], name: string) => req<ResumeMeta>(`${s(id)}/finalize`, post({ accepted, name })),
  facts: () => req<{ facts: Fact[] }>("/api/facts"),
  saveFacts: (facts: Fact[]) => req<void>("/api/facts", { method: "PUT", body: JSON.stringify({ facts }) }),
};

// ---- Reading a session ------------------------------------------------------------------------------------

/** What an edit replaces, as plain markup, and where it sits (for the review screen). */
export function editContext(doc: ResumeDoc | undefined, change: EditOp): { before: string | null; where: string; section: string } {
  if (!doc) return { before: null, where: "", section: "" };
  if (change.op === "set_headline") return { before: doc.headline?.text ?? null, where: "Headline", section: "Header" };
  for (const sec of doc.sections) {
    if (sec.paragraph?.id === change.target) return { before: sec.paragraph.text, where: sec.title, section: sec.title };
    for (const line of sec.skills) if (line.id === change.target) return { before: line.text, where: line.label || sec.title, section: sec.title };
    for (const list of sec.lists) {
      if (list.id === change.target) {
        const before = change.op === "reorder_bullets" ? list.bullets.map((b) => b.text).join("\n") : null;
        return { before, where: list.heading, section: sec.title };
      }
      const b = list.bullets.find((x) => x.id === change.target);
      if (b) return { before: b.text, where: list.heading, section: sec.title };
    }
  }
  return { before: null, where: "", section: "" };
}

/** The text of any resume element by id (for evidence links). */
export function elementText(doc: ResumeDoc | undefined, facts: Fact[], id: string): string | null {
  const f = facts.find((x) => x.id === id);
  if (f) return f.text;
  if (!doc) return null;
  if (doc.headline?.id === id) return doc.headline.text;
  for (const sec of doc.sections) {
    if (sec.paragraph?.id === id) return sec.paragraph.text;
    for (const line of sec.skills) if (line.id === id) return `${line.label ? `${line.label}: ` : ""}${line.text}`;
    for (const list of sec.lists) {
      if (list.id === id) return list.heading;
      const b = list.bullets.find((x) => x.id === id);
      if (b) return b.text;
    }
  }
  return null;
}

/** Light markup (**bold**, *italic*, [text](url)) → plain text. */
export function plainText(markup: string): string {
  return markup
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2");
}

export type DiffPart = { kind: "same" | "add" | "del"; text: string };

/** Word-level diff of two texts (LCS over words and the spaces between them). */
export function wordDiff(a: string, b: string): DiffPart[] {
  const A = a.match(/\s+|[^\s]+/g) ?? [];
  const B = b.match(/\s+|[^\s]+/g) ?? [];
  const n = A.length;
  const m = B.length;
  // Too long for an O(n·m) table: show it as a replacement.
  if (n * m > 400_000) return [...(a ? [{ kind: "del" as const, text: a }] : []), ...(b ? [{ kind: "add" as const, text: b }] : [])];
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = out[out.length - 1];
    if (last?.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push("same", A[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push("del", A[i++]);
    else push("add", B[j++]);
  }
  while (i < n) push("del", A[i++]);
  while (j < m) push("add", B[j++]);
  return out;
}
