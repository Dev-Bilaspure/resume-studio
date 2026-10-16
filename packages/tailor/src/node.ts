// Node.js storage for sessions and facts: one JSON file per session, one file for the fact bank. Writes
// are atomic (temp file + rename) so a crash never leaves a half-written session.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FactStore, SessionStore } from "./adapters.ts";
import type { Fact, Session } from "./types.ts";

async function atomicWrite(path: string, data: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export function fileSessionStore(dir: string): SessionStore {
  const file = (id: string) => {
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error("Invalid session id");
    return join(dir, `${id}.json`);
  };
  return {
    async get(id) {
      try {
        return JSON.parse(await readFile(file(id), "utf8")) as Session;
      } catch {
        return null;
      }
    },
    async put(s) {
      await atomicWrite(file(s.id), JSON.stringify(s, null, 2));
    },
  };
}

export function fileFactStore(path: string): FactStore {
  const read = async (): Promise<Fact[]> => {
    try {
      return (JSON.parse(await readFile(path, "utf8")) as { facts: Fact[] }).facts ?? [];
    } catch {
      return [];
    }
  };
  return {
    list: read,
    async add(more) {
      const facts = await read();
      for (const f of more) if (!facts.some((x) => x.id === f.id || x.text === f.text)) facts.push(f);
      await atomicWrite(path, JSON.stringify({ facts }, null, 2) + "\n");
    },
  };
}
