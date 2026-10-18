// Node.js storage for sessions and facts: one JSON file per session, one file for the fact bank. Writes
// are atomic (temp file + rename) so a crash never leaves a half-written file, and changes to the fact bank
// hold a lock, so two runs saving answers at once can't overwrite each other.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FactStore, SessionStore } from "./adapters.ts";
import type { Fact, Session } from "./types.ts";

async function atomicWrite(path: string, data: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** A file that exists but can't be read as JSON: reported, never mistaken for a missing one. */
export class CorruptFileError extends Error {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(`${path} is damaged and can't be read (${(cause as Error).message}). Fix or remove it.`);
    this.name = "CorruptFileError";
    this.path = path;
  }
}

/** The file's JSON, null if there's no file. */
async function readJson<T>(path: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new CorruptFileError(path, e);
  }
}

const STALE_LOCK_MS = 30_000;

/**
 * Runs `fn` holding `<path>.lock` (a directory: creating one is atomic on every OS and filesystem), so
 * other processes using the same file wait. A lock left by a crashed process is taken over after 30 s.
 */
async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const age = Date.now() - ((await stat(lock).catch(() => null))?.mtimeMs ?? Date.now());
      if (age > STALE_LOCK_MS) await rm(lock, { recursive: true, force: true });
      else if (attempt > 400) throw new Error(`${path} is locked by another process`);
      else await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export function fileSessionStore(dir: string): SessionStore {
  const file = (id: string) => {
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error("Invalid session id");
    return join(dir, `${id}.json`);
  };
  return {
    get: (id) => readJson<Session>(file(id)),
    async put(s) {
      await atomicWrite(file(s.id), JSON.stringify(s, null, 2));
    },
  };
}

export function fileFactStore(path: string): FactStore & { replace(facts: Fact[]): Promise<void> } {
  const read = async (): Promise<Fact[]> => (await readJson<{ facts: Fact[] }>(path))?.facts ?? [];
  return {
    list: read,
    /** Replaces the whole bank (editing it by hand), under the same lock as add. */
    async replace(facts) {
      await withFileLock(path, () => atomicWrite(path, JSON.stringify({ facts }, null, 2) + "\n"));
    },
    async add(more) {
      await withFileLock(path, async () => {
        const facts = await read();
        // The same thing said twice is kept once; a "lacks" topic is kept once per topic.
        const key = (f: Fact) => (f.kind === "lacks" ? `lacks:${(f.topic ?? f.text).toLowerCase()}` : `has:${f.text}`);
        const seen = new Set(facts.flatMap((f) => [f.id, key(f)]));
        for (const f of more) {
          if (seen.has(f.id) || seen.has(key(f))) continue;
          facts.push(f);
          seen.add(f.id);
          seen.add(key(f));
        }
        await atomicWrite(path, JSON.stringify({ facts }, null, 2) + "\n");
      });
    },
  };
}
