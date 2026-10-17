import "server-only";
import { readFile, stat } from "node:fs/promises";
import type { AtsReport } from "@/lib/types";
import { parsePdffonts, parsePdfinfo, runAtsChecks } from "./ats-checks";
import { inspectPdf, popplerMissing, toolchainMode } from "./toolchain";

/** Poppler tools (pdftotext, pdffonts, pdfinfo) the active toolchain lacks. */
export async function atsToolsMissing(): Promise<string[]> {
  return popplerMissing();
}

/** Extracts the PDF as an ATS would and runs the readiness checks. */
export async function analyzePdf(pdfPath: string, sources: Record<string, string>, mainFile: string): Promise<AtsReport | null> {
  const missing = await atsToolsMissing();
  if (missing.length) {
    return {
      score: 0,
      checks: [],
      text: "",
      stats: { pages: 0, words: 0, fileSizeKB: 0, fonts: [], title: null, author: null },
      unavailable:
        toolchainMode() === "service"
          ? "ATS checks need the compile service: start it with `docker compose up -d`"
          : `Install poppler for ATS checks (missing ${missing.join(", ")}): brew install poppler`,
    };
  }
  const [r, st] = await Promise.all([inspectPdf(pdfPath, { text: true, layout: true, fonts: true, info: true }), stat(pdfPath)]);
  const { text, layout, fonts, info } = r;
  if (!text || text.code !== 0) return null;
  const meta = parsePdfinfo(info?.stdout ?? "");
  return runAtsChecks({
    text: text.stdout,
    layoutText: layout?.code === 0 ? layout.stdout : undefined,
    pages: Number(meta["Pages"]) || 1,
    fileSizeKB: Math.round(st.size / 1024),
    fonts: parsePdffonts(fonts?.stdout ?? ""),
    title: meta["Title"] || null,
    author: meta["Author"] || null,
    sources,
    mainFile,
  });
}

/** Reads text sources for the source-level checks: [relative path, absolute path] pairs. */
export async function readSources(files: [string, string][]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    files.map(async ([rel, abs]) => {
      try {
        out[rel] = await readFile(abs, "utf8");
      } catch {
        // Deleted mid-build.
      }
    }),
  );
  return out;
}
