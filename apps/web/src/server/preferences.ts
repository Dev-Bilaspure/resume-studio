import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DIR } from "./config";
import { HttpError, atomicWrite } from "./fsutil";

// Your preferences (editor settings, autosave, preview zoom, pane sizes) live in the browser's storage for
// speed; the browser mirrors them here so they're backed up with everything else and a new browser, or a
// restored computer, gets them back. See components/preferences-mirror.tsx.

const FILE = join(STATE_DIR, "preferences.json");
const KEY = /^rs\.[A-Za-z0-9._-]{1,100}$/;
const MAX_KEYS = 200;
const MAX_VALUE = 20_000;

export interface Preferences {
  /** When they last changed (null: never saved). The browser uses it to tell whose copy is newer. */
  updatedAt: string | null;
  values: Record<string, string>;
}

export async function readPreferences(): Promise<Preferences> {
  try {
    const p = JSON.parse(await readFile(FILE, "utf8")) as Preferences;
    return { updatedAt: p.updatedAt ?? null, values: p.values ?? {} };
  } catch {
    return { updatedAt: null, values: {} };
  }
}

export async function writePreferences(values: Record<string, string>): Promise<Preferences> {
  const entries = Object.entries(values);
  if (entries.length > MAX_KEYS) throw new HttpError(400, "Too many preferences");
  for (const [k, v] of entries) {
    if (!KEY.test(k)) throw new HttpError(400, `Not a preference: ${k}`);
    if (typeof v !== "string" || v.length > MAX_VALUE) throw new HttpError(400, `Preference ${k} is too long`);
  }
  const prefs: Preferences = { updatedAt: new Date().toISOString(), values: Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) };
  await atomicWrite(FILE, JSON.stringify(prefs, null, 2) + "\n");
  return prefs;
}
