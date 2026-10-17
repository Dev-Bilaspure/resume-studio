"use client";

import type { ApplicationStatus, BuildResult, BuildState, FileContent, FileEntry, OutputFile, ProjectSymbols, ResumeMeta, SnapshotInfo, SystemStatus, WordCount } from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init?.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`, data as Record<string, unknown>);
  return data as T;
}

const enc = encodeURIComponent;
const r = (id: string) => `/api/resumes/${enc(id)}`;

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
}

export interface ResumeSummary extends ResumeMeta {
  build: { score: number | null; pages: number | null; pdfUrl: string | null; status: BuildResult["status"] | null };
}

export const api = {
  system: () => req<SystemStatus>("/api/system"),
  list: () => req<{ resumes: ResumeSummary[]; templates: TemplateInfo[] }>("/api/resumes"),
  create: (body: { name: string; template?: string; duplicateOf?: string }) => req<ResumeMeta>("/api/resumes", { method: "POST", body: JSON.stringify(body) }),
  get: (id: string) => req<{ meta: ResumeMeta; files: FileEntry[]; build: BuildState }>(r(id)),
  update: (id: string, patch: Partial<Pick<ResumeMeta, "name" | "engine" | "mainFile" | "trusted" | "haltOnError">> & { applicationStatus?: ApplicationStatus }) =>
    req<ResumeMeta>(r(id), { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (id: string) => req<void>(r(id), { method: "DELETE" }),
  compile: (id: string) => req<void>(`${r(id)}/compile`, { method: "POST" }),
  /** "Clear cached files": drop the aux files, then rebuild. */
  clean: (id: string) => req<void>(`${r(id)}/compile`, { method: "POST", body: JSON.stringify({ clean: true }) }),
  symbols: (id: string) => req<ProjectSymbols>(`${r(id)}/symbols`),
  outputFiles: (id: string) => req<{ files: OutputFile[] }>(`${r(id)}/output`),
  outputFileUrl: (id: string, name: string, download = false) => `${r(id)}/output?file=${enc(name)}${download ? "&download=1" : ""}`,
  outputText: async (id: string, name: string) => {
    const res = await fetch(`${r(id)}/output?file=${enc(name)}`);
    if (!res.ok) throw new ApiError(res.status, "Not available");
    return res.text();
  },
  wordCount: (id: string) => req<WordCount>(`${r(id)}/wordcount`),
  zipUrl: (id: string) => `${r(id)}/zip`,
  importZip: (name: string, file: Blob) => req<{ id: string }>(`/api/resumes/import?name=${enc(name)}`, { method: "POST", body: file }),

  readFile: (id: string, path: string) => req<FileContent>(`${r(id)}/file?path=${enc(path)}`),
  rawFileUrl: (id: string, path: string) => `${r(id)}/file?path=${enc(path)}&raw=1`,
  saveFile: (id: string, path: string, content: string, baseHash: string | null) =>
    req<{ path: string; hash: string; mtimeMs: number }>(`${r(id)}/file?path=${enc(path)}`, { method: "PUT", body: JSON.stringify({ content, baseHash }) }),
  createFile: (id: string, path: string, kind: "file" | "dir", content?: string) =>
    req<void>(`${r(id)}/file?path=${enc(path)}`, { method: "POST", body: JSON.stringify({ kind, content }) }),
  renameFile: (id: string, path: string, to: string) => req<void>(`${r(id)}/file?path=${enc(path)}`, { method: "PATCH", body: JSON.stringify({ to }) }),
  deleteFile: (id: string, path: string) => req<void>(`${r(id)}/file?path=${enc(path)}`, { method: "DELETE" }),
  upload: (id: string, path: string, file: Blob) => req<void>(`${r(id)}/upload?path=${enc(path)}`, { method: "POST", body: file }),

  forwardSync: (id: string, build: number, file: string, line: number) =>
    req<{ boxes: { page: number; h: number; v: number; width: number; height: number }[] }>(`${r(id)}/synctex?build=${build}&file=${enc(file)}&line=${line}`),
  inverseSync: (id: string, build: number, page: number, x: number, y: number) =>
    req<{ file: string; line: number; column: number } | null>(`${r(id)}/synctex?build=${build}&page=${page}&x=${x}&y=${y}`),

  snapshots: (id: string) => req<{ snapshots: SnapshotInfo[] }>(`${r(id)}/snapshots`),
  snapshot: (id: string, body: { message?: string; label?: string }) =>
    req<SnapshotInfo | null>(`${r(id)}/snapshots`, { method: "POST", body: JSON.stringify(body) }),
  labelSnapshot: (id: string, sha: string, label: string) => req<void>(`${r(id)}/snapshots/${sha}/label`, { method: "POST", body: JSON.stringify({ label }) }),
  removeLabel: (id: string, label: string) => req<void>(`${r(id)}/snapshots?label=${enc(label)}`, { method: "DELETE" }),
  snapshotFiles: (id: string, sha: string) => req<{ files: string[] }>(`${r(id)}/snapshots/${sha}`),
  snapshotFile: (id: string, sha: string, path: string) => req<{ path: string; content: string }>(`${r(id)}/snapshots/${sha}?path=${enc(path)}`),
  previewSnapshot: (id: string, sha: string) => req<BuildResult>(`${r(id)}/snapshots/${sha}/preview`, { method: "POST" }),
  restoreSnapshot: (id: string, sha: string) => req<void>(`${r(id)}/snapshots/${sha}/restore`, { method: "POST" }),
};
