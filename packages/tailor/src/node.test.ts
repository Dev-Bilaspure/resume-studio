// The file stores: damaged files are reported, and concurrent fact saves don't lose each other's facts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { CorruptFileError, fileFactStore, fileSessionStore } from "./node.ts";
import type { Fact } from "./types.ts";

const dir = mkdtempSync(join(tmpdir(), "tailor-store-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const fact = (n: number): Fact => ({ id: `f-${n}`, text: `Fact number ${n}`, skills: [], source: "answer", createdAt: "2026-10-19T00:00:00Z" });

test("a missing session is null; a damaged one is an error", async () => {
  const store = fileSessionStore(join(dir, "sessions"));
  assert.equal(await store.get("nope"), null);
  await store.put({ id: "ok" } as never);
  writeFileSync(join(dir, "sessions", "bad.json"), "{ half a session");
  await assert.rejects(store.get("bad"), CorruptFileError);
});

test("facts saved at the same time are all kept, and duplicates aren't", async () => {
  const store = fileFactStore(join(dir, "facts.json"));
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.add([fact(i)])));
  assert.equal((await store.list()).length, 20);
  await store.add([fact(3), { ...fact(99), text: "Fact number 4" }]);
  assert.equal((await store.list()).length, 20, "same id or same text: kept once");
  await store.add([{ ...fact(50), kind: "lacks", topic: "Kubernetes" }, { ...fact(51), kind: "lacks", topic: "kubernetes" }]);
  assert.equal((await store.list()).filter((f) => f.kind === "lacks").length, 1, "a declined topic is kept once");
});
