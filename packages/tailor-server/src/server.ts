// The tailoring engine as an HTTP service. JSON in and out; progress as server-sent events.
//
//   GET    /health
//   GET    /v1/providers                       configured providers and their default models
//   POST   /v1/sessions                        start: { job, source, assets?, options?, facts?, provider?, model?, context? }
//   GET    /v1/sessions/:id                    the session (without raw source/draft files)
//   GET    /v1/sessions/:id/events             server-sent events: every step, live (history replayed first)
//   POST   /v1/sessions/:id/answers            { answers: [{ questionId, text? , none? }] }; [] skips the questions
//   POST   /v1/sessions/:id/retry              after a failure, a cancel or an interruption
//   POST   /v1/sessions/:id/cancel
//   POST   /v1/sessions/:id/preview            { accepted: [editId] } → { source, build }
//   POST   /v1/sessions/:id/finalize           { accepted: [editId] } → { source, facts }
//   DELETE /v1/sessions/:id
//
// Errors are { error: { code, message } } with a matching HTTP status.
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, normalize } from "node:path";
import { LLMError, PROVIDERS, createLLM, type ProviderId } from "@resume-studio/llm";
import { ENGINE_VERSION, PROMPTS_VERSION, SessionError, createTailorEngine, type Session, type TailorEvent } from "@resume-studio/tailor";
import { fileSessionStore } from "@resume-studio/tailor/node";
import { latexAdapter } from "@resume-studio/tailor-latex";
import { defaultVerifier } from "@resume-studio/tailor-latex/node";
import { z } from "zod";
import type { ServerConfig } from "./config.ts";

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---- Request bodies ---------------------------------------------------------------------------------------

const Seniority = z.enum(["intern", "junior", "mid", "senior", "staff", "principal", "manager"]);
const Start = z.object({
  job: z.object({
    // Optional: read from the posting when left out.
    company: z.string().trim().max(200).default(""),
    role: z.string().trim().max(200).default(""),
    seniority: Seniority.optional(),
    description: z.string().trim().min(80, "the job description looks incomplete").max(60_000),
    location: z.string().max(200).optional(),
    link: z.string().max(2000).optional(),
    notes: z.string().max(4000).optional(),
  }),
  source: z.object({
    format: z.literal("latex").default("latex"),
    main: z.string().min(1).max(300),
    files: z.record(z.string().max(300), z.string().max(2_000_000)),
  }),
  /** Binary files the document needs (images, fonts, PDFs), base64. */
  assets: z.record(z.string().max(300), z.string()).optional(),
  options: z
    .object({
      maxPages: z.number().int().min(1).max(4).optional(),
      allowHeadline: z.boolean().optional(),
      allowNewSkills: z.boolean().optional(),
      askQuestions: z.boolean().optional(),
    })
    .optional(),
  facts: z
    .array(
      z.object({
        id: z.string().max(100),
        text: z.string().min(1).max(2000),
        skills: z.array(z.string().max(100)).max(50),
        source: z.enum(["answer", "manual", "import"]),
        createdAt: z.string(),
      }),
    )
    .max(500)
    .optional(),
  provider: z.enum(["claude-code", "openai", "anthropic", "vertex"]).optional(),
  model: z.string().max(200).optional(),
  /** Yours to keep on the session (user id, resume id…); the engine doesn't read it. */
  context: z.record(z.string().max(100), z.string().max(1000)).optional(),
});
const Answers = z.object({
  answers: z.array(z.object({ questionId: z.string(), text: z.string().max(4000).optional(), none: z.boolean().optional() })).max(50),
});
const Accepted = z.object({ accepted: z.array(z.string()).max(500) });

// ---- Helpers ----------------------------------------------------------------------------------------------

function send(res: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(json);
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "too_large", `The request is larger than ${Math.round(limit / 1024 / 1024)} MB`);
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_json", "The request body isn't valid JSON");
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw new HttpError(400, "invalid_request", `${first.path.join(".") || "body"}: ${first.message}`);
}

function sameSecret(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A relative path that stays inside its folder. */
function safePath(p: string) {
  const n = normalize(p).replace(/^(\.\/)+/, "");
  if (!n || n.startsWith("..") || n.startsWith("/") || n.includes("\0")) throw new HttpError(400, "invalid_path", `Invalid file path: ${p}`);
  return n;
}

const WORKING = new Set<Session["status"]>(["created", "analyzing", "writing", "verifying"]);

// ---- The server -------------------------------------------------------------------------------------------

export interface ServerDeps {
  /** How a provider config becomes a model client (tests swap in a scripted one). */
  createLLM?: typeof createLLM;
}

export function createTailorServer(config: ServerConfig, deps: ServerDeps = {}): Server {
  const makeLLM = deps.createLLM ?? createLLM;
  const sessionsDir = join(config.dataDir, "sessions");
  const store = fileSessionStore(sessionsDir);
  const listeners = new Map<string, Set<ServerResponse>>();
  const running = new Map<string, AbortController>();
  let active = 0;
  const waiting: (() => void)[] = [];

  const assetsDir = (id: string) => join(config.dataDir, "assets", id);

  function broadcast(id: string, e: TailorEvent, s: Session) {
    const set = listeners.get(id);
    if (!set) return;
    const data = `event: tailor\ndata: ${JSON.stringify({ ...e, status: s.status })}\n\n`;
    for (const res of set) res.write(data);
  }

  function providerConfig(provider: ProviderId | undefined, model: string | undefined) {
    const id = provider ?? config.defaultProvider;
    const p = config.providers.find((x) => x.provider === id);
    if (!p)
      throw new HttpError(
        400,
        "provider_unavailable",
        `Provider ${id} isn't configured on this server. Available: ${config.providers.map((x) => x.provider).join(", ")}`,
      );
    const m = model ?? config.defaultModels[p.provider] ?? PROVIDERS.find((x) => x.id === p.provider)?.defaultModel;
    if (!m) throw new HttpError(400, "model_required", `Name a model for ${p.provider}`);
    return { ...p, model: m };
  }

  function llmFor(provider: ProviderId | undefined, model: string | undefined) {
    try {
      return makeLLM(providerConfig(provider, model));
    } catch (e) {
      if (e instanceof LLMError) throw new HttpError(400, "provider_unavailable", e.message);
      throw e;
    }
  }

  function engineFor(s: { id: string; context: Record<string, string> }) {
    const llm = llmFor(s.context._provider as ProviderId, s.context._model);
    return createTailorEngine({
      llm,
      adapter: latexAdapter,
      verifier: defaultVerifier({ assetsDir: assetsDir(s.id) }),
      store,
      onEvent: (id, e, sess) => broadcast(id, e, sess),
    });
  }

  /** Runs a session in the background, at most `concurrency` at a time. */
  function runInBackground(s: Session) {
    if (running.has(s.id)) return;
    const ctl = new AbortController();
    running.set(s.id, ctl);
    const engine = engineFor(s);
    const go = async () => {
      active++;
      try {
        if (!ctl.signal.aborted) await engine.run(s.id, ctl.signal);
      } catch (e) {
        console.error(`[tailor] ${s.id}`, e);
      } finally {
        active--;
        running.delete(s.id);
        waiting.shift()?.();
      }
    };
    if (active < config.concurrency) void go();
    else waiting.push(() => void go());
  }

  async function load(id: string) {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) throw new HttpError(404, "not_found", "No such session");
    const s = await store.get(id);
    if (!s) throw new HttpError(404, "not_found", "No such session");
    return s;
  }

  function view(s: Session) {
    const { source: _source, draft: _draft, ...rest } = s;
    void _source;
    void _draft;
    const strip = <T extends { build?: { text?: string } }>(c: T) => (c.build ? { ...c, build: { ...c.build, text: undefined } } : c);
    return {
      ...rest,
      report: rest.report && { ...rest.report, before: strip(rest.report.before), after: strip(rest.report.after) },
      running: running.has(s.id),
      // Says it's working, but nothing here runs it: the server restarted mid-run. POST …/retry resumes it.
      interrupted: WORKING.has(s.status) && !running.has(s.id),
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, engine: ENGINE_VERSION, prompts: PROMPTS_VERSION });

    if (config.apiKey) {
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token || !sameSecret(token, config.apiKey)) throw new HttpError(401, "unauthorized", "Send Authorization: Bearer <TAILOR_API_KEY>");
    }

    if (parts[0] !== "v1") throw new HttpError(404, "not_found", "Not found");

    if (method === "GET" && parts[1] === "providers" && parts.length === 2) {
      return send(res, 200, {
        default: config.defaultProvider,
        providers: config.providers.map((p) => {
          const info = PROVIDERS.find((x) => x.id === p.provider)!;
          return { id: p.provider, label: info.label, defaultModel: config.defaultModels[p.provider] ?? info.defaultModel, models: info.models };
        }),
      });
    }

    if (parts[1] !== "sessions") throw new HttpError(404, "not_found", "Not found");

    if (parts.length === 2 && method === "POST") {
      const body = parse(Start, await readJson(req, config.maxBodyBytes));
      const p = providerConfig(body.provider, body.model);
      const files = Object.fromEntries(Object.entries(body.source.files).map(([k, v]) => [safePath(k), v]));
      const main = safePath(body.source.main);
      if (!(main in files)) throw new HttpError(400, "invalid_request", `source.files has no ${main}`);
      const engine = createTailorEngine({ llm: llmFor(p.provider, p.model), adapter: latexAdapter, store });
      const s = await engine.start({
        job: body.job,
        source: { main, files },
        options: body.options,
        facts: body.facts,
        context: { ...(body.context ?? {}), _provider: p.provider, _model: p.model },
      });
      if (body.assets) {
        for (const [path, b64] of Object.entries(body.assets)) {
          const target = join(assetsDir(s.id), safePath(path));
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, Buffer.from(b64, "base64"));
        }
      }
      runInBackground(s);
      return send(res, 202, view(s));
    }

    const id = parts[2];
    const action = parts[3];
    if (!id || parts.length > 4) throw new HttpError(404, "not_found", "Not found");

    if (!action && method === "GET") return send(res, 200, view(await load(id)));

    if (!action && method === "DELETE") {
      const s = await load(id);
      running.get(s.id)?.abort();
      rmSync(join(sessionsDir, `${s.id}.json`), { force: true });
      rmSync(assetsDir(s.id), { recursive: true, force: true });
      return send(res, 204);
    }

    if (action === "events" && method === "GET") {
      const s = await load(id);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      for (const e of s.events) res.write(`event: tailor\ndata: ${JSON.stringify(e)}\n\n`);
      res.write(`event: session\ndata: ${JSON.stringify({ status: s.status, running: running.has(s.id) })}\n\n`);
      const set = listeners.get(id) ?? new Set();
      set.add(res);
      listeners.set(id, set);
      const beat = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(beat);
        set.delete(res);
        if (!set.size) listeners.delete(id);
      });
      return;
    }

    if (method !== "POST") throw new HttpError(405, "method_not_allowed", `${method} isn't supported here`);

    if (action === "answers") {
      const { answers } = parse(Answers, await readJson(req, 1024 * 1024));
      const s = await load(id);
      await engineFor(s).answer(id, answers);
      runInBackground(await load(id));
      return send(res, 202, view(await load(id)));
    }
    if (action === "retry") {
      const s = await load(id);
      if (running.has(id)) return send(res, 202, view(s));
      await engineFor(s).retry(id);
      runInBackground(await load(id));
      return send(res, 202, view(await load(id)));
    }
    if (action === "cancel") {
      const ctl = running.get(id);
      if (ctl) ctl.abort();
      else {
        const s = await load(id);
        if (WORKING.has(s.status)) await store.put({ ...s, status: "cancelled", updatedAt: new Date().toISOString(), error: { message: "Cancelled" } });
      }
      return send(res, 200, view(await load(id)));
    }
    if (action === "preview" || action === "finalize") {
      const { accepted } = parse(Accepted, await readJson(req, 1024 * 1024));
      const s = await load(id);
      const engine = engineFor(s);
      if (action === "finalize") return send(res, 200, await engine.finalize(id, accepted));
      const source = await engine.preview(id, accepted);
      const build = await defaultVerifier({ assetsDir: assetsDir(id) }).build(source, { maxPages: s.options.maxPages });
      return send(res, 200, { source, build: { ok: build.ok, pages: build.pages, errors: build.errors } });
    }
    throw new HttpError(404, "not_found", "Not found");
  }

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return send(res, e.status, { error: { code: e.code, message: e.message } });
      if (e instanceof SessionError) return send(res, e.status, { error: { code: "session", message: e.message } });
      console.error("[tailor-server]", e);
      send(res, 500, { error: { code: "internal", message: "Something went wrong on the server" } });
    });
  });
}
