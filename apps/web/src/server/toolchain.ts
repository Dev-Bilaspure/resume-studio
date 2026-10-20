import "server-only";
import { readFile, rm } from "node:fs/promises";
import { relative } from "node:path";
import {
  createTexServiceClient,
  DEFAULT_PORT,
  sha256,
  type InfoResponse,
  type InspectOptions,
  type InspectResponse,
  type TexServiceClient,
} from "@resume-studio/tex-service";
import { STATE_DIR, findTool } from "./config";
import { run } from "./run";

/**
 * Where TeX runs: on this machine (TeX Live / MacTeX installed), or in the compile service, the TeX Live
 * container from docker-compose.yml. RESUME_STUDIO_COMPILER picks:
 *   auto     (default) this machine's TeX if latexmk is installed, else the compile service
 *   local    always this machine's TeX
 *   service  always the compile service (RESUME_STUDIO_COMPILER_URL, default http://127.0.0.1:4380)
 */
export type ToolchainMode = "local" | "service";

const SETTING = (process.env.RESUME_STUDIO_COMPILER ?? "auto").toLowerCase();
const SERVICE_URL = process.env.RESUME_STUDIO_COMPILER_URL || `http://127.0.0.1:${DEFAULT_PORT}`;
const SERVICE_TOKEN = process.env.RESUME_STUDIO_COMPILER_TOKEN || undefined;

if (!["auto", "local", "service", "docker"].includes(SETTING)) {
  console.warn(`[resume-studio] RESUME_STUDIO_COMPILER="${SETTING}" isn't auto, local or service; using auto.`);
}

export function toolchainMode(): ToolchainMode {
  if (SETTING === "local") return "local";
  if (SETTING === "service" || SETTING === "docker") return "service";
  return findTool("latexmk") ? "local" : "service";
}

const g = globalThis as unknown as { __rsTexService?: TexServiceClient };

/** The compile service's client (one per process: it remembers what each project already has). */
export function texService(): TexServiceClient {
  return (g.__rsTexService ??= createTexServiceClient({ url: SERVICE_URL, token: SERVICE_TOKEN }));
}

let infoCache: { at: number; value: InfoResponse | Error } | null = null;

/** The service's toolchain, or why it can't be reached (cached for a few seconds: pages poll the status). */
export async function serviceInfo(): Promise<InfoResponse | Error> {
  if (infoCache && Date.now() - infoCache.at < 3_000) return infoCache.value;
  const value = await texService()
    .info()
    .catch((e: Error) => e);
  infoCache = { at: Date.now(), value };
  return value;
}

/**
 * The service's project for a build folder of this app: one per folder, named after its place under
 * .resume-studio (build/first-resume → build_first-resume-1a2b3c4d), so it stays the same across restarts
 * and builds stay incremental.
 */
export function serviceProject(outDir: string): string {
  const rel = relative(STATE_DIR, outDir) || "root";
  const readable =
    rel
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^[^A-Za-z0-9]+/, "")
      .slice(0, 96) || "p";
  return `${readable}-${sha256(outDir).slice(0, 8)}`;
}

/** Deletes a build folder, and its project on the compile service. */
export async function releaseBuildDir(outDir: string) {
  await rm(outDir, { recursive: true, force: true });
  if (toolchainMode() === "service")
    await texService()
      .deleteProject(serviceProject(outDir))
      .catch(() => {});
}

// ---- PDF tools (poppler) ----------------------------------------------------------------------------------

const POPPLER = ["pdftotext", "pdffonts", "pdfinfo"] as const;

/** Poppler tools the active toolchain lacks (empty when all are there). */
export async function popplerMissing(): Promise<string[]> {
  if (toolchainMode() === "local") return POPPLER.filter((t) => !findTool(t));
  const info = await serviceInfo();
  return info instanceof Error ? [...POPPLER] : info.poppler.missing;
}

/** pdftotext / pdffonts / pdfinfo on a PDF, here or on the compile service: the same output either way. */
export async function inspectPdf(pdfPath: string, o: InspectOptions): Promise<InspectResponse> {
  if (toolchainMode() === "service") {
    return texService().inspectPdf(await readFile(pdfPath), o);
  }
  const range = [...(o.first ? ["-f", String(o.first)] : []), ...(o.last ? ["-l", String(o.last)] : [])];
  const tool = async (cmd: string, args: string[]) => {
    const r = await run(cmd, args, { timeoutMs: 15_000 });
    return { code: r.error ? null : r.code, stdout: r.stdout, stderr: r.stderr };
  };
  const out: InspectResponse = {};
  await Promise.all([
    o.text && tool("pdftotext", ["-enc", "UTF-8", "-nopgbrk", ...range, pdfPath, "-"]).then((r) => (out.text = r)),
    o.layout && tool("pdftotext", ["-enc", "UTF-8", "-nopgbrk", "-layout", ...range, pdfPath, "-"]).then((r) => (out.layout = r)),
    o.fonts && tool("pdffonts", [pdfPath]).then((r) => (out.fonts = r)),
    o.info && tool("pdfinfo", ["-enc", "UTF-8", pdfPath]).then((r) => (out.info = r)),
  ]);
  return out;
}
