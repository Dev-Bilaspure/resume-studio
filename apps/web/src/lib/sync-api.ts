"use client";

import type { SyncDiff, SyncStatus } from "./types";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Backup & sync with your private repository (see src/server/sync.ts). */
export const syncApi = {
  /** `check`: ask the repository what's new first. */
  status: (check = false) => req<SyncStatus>(`/api/sync${check ? "?check=1" : ""}`),
  connect: (url: string) => req<SyncStatus>("/api/sync/connect", { method: "POST", body: JSON.stringify({ url }) }),
  disconnect: () => req<SyncStatus>("/api/sync", { method: "DELETE" }),
  upload: () => req<SyncStatus>("/api/sync/upload", { method: "POST" }),
  download: (resolutions: Record<string, "local" | "remote">) => req<SyncStatus>("/api/sync/download", { method: "POST", body: JSON.stringify({ resolutions }) }),
  diff: (path: string, side: "local" | "remote" | "conflict") => req<SyncDiff>(`/api/sync/diff?path=${encodeURIComponent(path)}&side=${side}`),
};
