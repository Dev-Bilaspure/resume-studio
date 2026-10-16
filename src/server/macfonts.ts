import "server-only";
import { run } from "./run";
import { fontKey } from "./engine";

// Fonts installed in macOS (what XeLaTeX can find by name there). Listed through AppKit via JXA in
// ~0.2 s and cached; null where that isn't possible (not macOS, osascript missing).

let cache: { at: number; keys: Set<string> } | null = null;
const TTL_MS = 10 * 60_000;

export async function macFontKeys(): Promise<Set<string> | null> {
  if (process.platform !== "darwin") return null;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.keys;
  const script =
    'ObjC.import("AppKit"); var m = $.NSFontManager.sharedFontManager; JSON.stringify(m.availableFontFamilies.js.map(function (x) { return x.js; }).concat(m.availableFonts.js.map(function (x) { return x.js; })))';
  const res = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { timeoutMs: 10_000 });
  if (res.code !== 0) return null;
  try {
    const names = JSON.parse(res.stdout) as string[];
    cache = { at: Date.now(), keys: new Set(names.map(fontKey)) };
    return cache.keys;
  } catch {
    return null;
  }
}

/** Requested font names macOS doesn't have (so XeLaTeX here can't load them by name). */
export async function missingMacFonts(requested: string[]): Promise<string[] | null> {
  const keys = await macFontKeys();
  if (!keys) return null;
  return requested.filter((name) => {
    const k = fontKey(name);
    if (keys.has(k)) return false;
    // "Lato Light" is fine when a "Lato Light" face or the "Lato" family plus a Light face exists.
    for (const have of keys) if (have.startsWith(k)) return false;
    return true;
  });
}
