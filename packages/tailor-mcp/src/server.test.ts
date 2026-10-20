// The MCP server through the real protocol (in-memory transport): questions, answers, the review text
// and saving, with a scripted model, the real LaTeX adapter and real TeX builds.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { GenerateRequest, LLM } from "@resume-studio/llm";
import { fileFactStore, fileSessionStore } from "@resume-studio/tailor/node";
import { createMcpServer } from "./server.ts";

const hasTex = (() => {
  try {
    execFileSync("latexmk", ["-v"], { env: { ...process.env, PATH: `/Library/TeX/texbin:/opt/homebrew/bin:${process.env.PATH}` }, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const tmp = mkdtempSync(join(tmpdir(), "tailor-mcp-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function scriptedLLM(): LLM {
  const script: Record<string, (req: GenerateRequest<unknown>) => unknown> = {
    job_profile: () => ({
      roleFamily: "infra",
      seniority: "senior",
      summary: "Platform team.",
      requirements: [{ text: "Terraform", kind: "must", category: "infrastructure", keywords: ["Terraform"] }],
      keywords: [{ term: "Terraform", aliases: [], importance: "must", kind: "term" }],
      responsibilities: [],
      dealBreakers: [],
    }),
    requirement_matches: () => ({
      matches: [{ requirementId: "r1", status: "missing", evidence: [], note: "No Terraform on the resume." }],
      questions: [{ requirementId: "r1", topic: "Terraform", question: "Have you used Terraform? Where?" }],
    }),
    facts: () => ({ facts: [{ questionId: "q1", text: "Wrote Terraform modules for the staging VPC.", skills: ["Terraform"] }] }),
    resume_edits: (req) => {
      const fact = /FACT \[([^\]]+)\]/.exec(String(req.prompt))![1];
      const list = /ENTRY \[(l\d+)\]/.exec(String(req.prompt))![1];
      return {
        strategy: "Show the Terraform work.",
        edits: [
          {
            op: "add_bullet",
            target: list,
            text: "Wrote **Terraform** modules for the staging VPC.",
            after: null,
            order: null,
            reason: "Shows the must-have.",
            requirements: ["r1"],
            evidence: [{ kind: "fact", id: fact }],
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

async function connect() {
  const server = createMcpServer({
    provider: { provider: "anthropic", apiKey: "unused", model: "scripted" },
    store: fileSessionStore(join(tmp, "sessions")),
    facts: fileFactStore(join(tmp, "facts.json")),
    createLLM: () => scriptedLLM(),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

test("the tools are listed with their inputs", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["answer_tailoring_questions", "get_tailoring_session", "save_tailored_resume", "tailor_resume"]);
  assert.ok((tools.find((t) => t.name === "tailor_resume")!.inputSchema.required as string[]).includes("resume_path"));
});

test("questions, answers, review and saving to a new folder", { skip: !hasTex && "TeX isn't installed" }, async () => {
  const resume = join(tmp, "resume");
  mkdirSync(resume);
  writeFileSync(join(resume, "main.tex"), readFileSync(new URL("../../tailor-latex/src/fixtures/classic.tex", import.meta.url)));
  const client = await connect();

  const first = textOf(
    await client.callTool({
      name: "tailor_resume",
      arguments: {
        resume_path: resume,
        company: "Northwind",
        role: "Platform Engineer",
        job_description: "We need Terraform and Kubernetes experience for our platform team. ".repeat(3),
      },
    }),
  );
  assert.match(first, /needs_input/);
  assert.match(first, /\[q1\] \(Terraform\)/);
  assert.match(first, /Never answer for them/);
  const id = /Session (\S+)/.exec(first)![1];

  const done = textOf(
    await client.callTool({
      name: "answer_tailoring_questions",
      arguments: { session_id: id, answers: [{ question_id: "q1", answer: "Terraform modules for our staging VPC." }] },
    }),
  );
  assert.match(done, /· ready/);
  assert.match(done, /add_bullet: "Wrote Terraform modules for the staging VPC\."/);
  assert.match(readFileSync(join(tmp, "facts.json"), "utf8"), /Terraform modules/, "the answer is remembered as a fact");

  const refused = await client.callTool({ name: "save_tailored_resume", arguments: { session_id: id, output_dir: resume } });
  assert.equal((refused as { isError?: boolean }).isError, true);
  assert.match(textOf(refused), /never overwritten/);

  const out = join(tmp, "tailored");
  assert.match(textOf(await client.callTool({ name: "save_tailored_resume", arguments: { session_id: id, output_dir: out } })), /1 of 1 changes/);
  assert.match(readFileSync(join(out, "main.tex"), "utf8"), /Wrote \\textbf\{Terraform\} modules for the staging VPC\./);
  assert.ok(existsSync(join(out, "jd.md")));
  assert.doesNotMatch(readFileSync(join(resume, "main.tex"), "utf8"), /staging VPC/, "the original is unchanged");
});
