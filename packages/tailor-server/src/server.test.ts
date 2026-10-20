// The service end to end over real HTTP: a scripted model, the real LaTeX adapter and real TeX builds.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { GenerateRequest, LLM } from "@resume-studio/llm";
import type { ServerConfig } from "./config.ts";
import { createTailorServer } from "./server.ts";

const hasTex = (() => {
  try {
    execFileSync("latexmk", ["-v"], { env: { ...process.env, PATH: `/Library/TeX/texbin:/opt/homebrew/bin:${process.env.PATH}` }, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const classic = readFileSync(new URL("../../tailor-latex/src/fixtures/classic.tex", import.meta.url), "utf8");

// Answers by schema name. The edit rewrites the first bullet into the same words plus "reliably",
// citing that bullet, so it passes the checks and shows up in the finalized source.
function scriptedLLM(): LLM {
  const script: Record<string, (req: GenerateRequest<unknown>) => unknown> = {
    job_profile: () => ({
      roleFamily: "backend",
      seniority: "senior",
      summary: "Payments platform.",
      requirements: [{ text: "Kafka", kind: "must", category: "infrastructure", keywords: ["Kafka"] }],
      keywords: [{ term: "Kafka", aliases: [], importance: "must", kind: "term" }],
      responsibilities: [],
      dealBreakers: [],
    }),
    requirement_matches: () => ({ matches: [{ requirementId: "r1", status: "weak", evidence: [], note: "n" }], questions: [] }),
    resume_edits: (req) => {
      const m = /BULLET \[(b\d+)\]: (.+)/.exec(String(req.prompt))!;
      return {
        strategy: "Lead with Kafka.",
        edits: [
          {
            op: "rewrite_bullet",
            target: m[1],
            text: `${m[2].replace(/\.$/, "")} reliably.`,
            after: null,
            order: null,
            reason: "r",
            requirements: ["r1"],
            evidence: [{ kind: "bullet", id: m[1] }],
          },
        ],
      };
    },
    fact_check: (req) => ({
      verdicts: [...String(req.prompt).matchAll(/<edit id="(e\d+)">/g)].map((m) => ({ editId: m[1], verdict: "supported", problems: [] })),
    }),
  };
  return {
    provider: "anthropic",
    model: "scripted",
    async generate<T>(req: GenerateRequest<T>) {
      const f = script[req.schemaName ?? ""];
      if (!f) throw new Error(`no script for ${req.schemaName}`);
      return {
        data: req.schema.parse(f(req as GenerateRequest<unknown>)),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        provider: "anthropic",
        model: "scripted",
        durationMs: 1,
      };
    },
  };
}

let base = "";
let dataDir = "";
let close = () => {};

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "tailor-server-test-"));
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    apiKey: "secret",
    dataDir,
    providers: [{ provider: "anthropic", apiKey: "unused" }],
    defaultProvider: "anthropic",
    defaultModels: { anthropic: "scripted" },
    maxBodyBytes: 1024 * 1024,
    concurrency: 1,
  };
  const server = createTailorServer(config, { createLLM: () => scriptedLLM() });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

after(() => {
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

const call = (path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}) =>
  fetch(base + path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { ...(init.auth === false ? {} : { authorization: "Bearer secret" }), ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

const job = { company: "Acme", role: "Senior Backend Engineer", description: "We need Kafka and Go for our payments platform. ".repeat(4) };

test("health is open; everything else needs the key", async () => {
  assert.equal((await call("/health", { auth: false })).status, 200);
  const r = await call("/v1/providers", { auth: false });
  assert.equal(r.status, 401);
  assert.equal(((await r.json()) as { error: { code: string } }).error.code, "unauthorized");
});

test("bad requests are explained", async () => {
  const r = await call("/v1/sessions", { body: { job: { ...job, description: "short" }, source: { main: "main.tex", files: { "main.tex": classic } } } });
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: { message: string } }).error.message, /job.description/);
  const p = await call("/v1/sessions", { body: { job, source: { main: "main.tex", files: { "main.tex": classic } }, provider: "openai" } });
  assert.equal(p.status, 400);
  assert.equal(((await p.json()) as { error: { code: string } }).error.code, "provider_unavailable");
  const path = await call("/v1/sessions", { body: { job, source: { main: "../main.tex", files: { "../main.tex": classic } } } });
  assert.equal(path.status, 400);
  assert.equal((await call("/v1/sessions/nope")).status, 404);
});

test("a session runs to ready with live events, then previews and finalizes", { skip: !hasTex && "TeX isn't installed" }, async () => {
  const r = await call("/v1/sessions", {
    body: { job, source: { main: "main.tex", files: { "main.tex": classic } }, options: { askQuestions: false }, context: { user: "u1" } },
  });
  assert.equal(r.status, 202);
  const started = (await r.json()) as { id: string; context: Record<string, string>; source?: unknown };
  assert.equal(started.context.user, "u1");
  assert.equal(started.source, undefined, "raw sources aren't sent back");

  // Live progress.
  const events: string[] = [];
  const stream = await call(`/v1/sessions/${started.id}/events`);
  const reader = stream.body!.getReader();
  const reading = (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      events.push(dec.decode(value));
    }
  })();

  let s: { status: string; edits?: { id: string; status: string }[]; running: boolean; report?: { after: { build?: { text?: string; pages: number } } } } = {
    status: "",
    running: true,
  };
  for (let i = 0; i < 120 && s.status !== "ready" && s.status !== "failed"; i++) {
    await new Promise((res) => setTimeout(res, 500));
    s = (await (await call(`/v1/sessions/${started.id}`)).json()) as typeof s;
  }
  assert.equal(s.status, "ready", JSON.stringify(s).slice(0, 500));
  assert.equal(s.edits?.length, 1);
  assert.equal(s.report?.after.build?.pages, 1);
  assert.equal(s.report?.after.build?.text, undefined, "extracted PDF text isn't sent back");
  await reader.cancel();
  await reading.catch(() => {});
  assert.match(events.join(""), /Compiling the draft/);

  const pv = (await (await call(`/v1/sessions/${started.id}/preview`, { body: { accepted: [] } })).json()) as { build: { ok: boolean; pages: number } };
  assert.deepEqual([pv.build.ok, pv.build.pages], [true, 1]);

  const fin = (await (await call(`/v1/sessions/${started.id}/finalize`, { body: { accepted: [s.edits![0].id] } })).json()) as {
    source: { files: Record<string, string> };
  };
  assert.match(fin.source.files["main.tex"], /reliably\./);

  assert.equal((await call(`/v1/sessions/${started.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await call(`/v1/sessions/${started.id}`)).status, 404);
});
