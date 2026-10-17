// resume-tailor-mcp: the MCP server over stdio, for assistants on this computer (Claude Desktop, Claude Code…).
// Model: the first provider the environment has credentials for (ANTHROPIC_API_KEY, OPENAI_API_KEY,
// GOOGLE_VERTEX_PROJECT + GOOGLE_VERTEX_LOCATION), else your Claude Code login. TAILOR_PROVIDER and
// TAILOR_MODEL choose explicitly. Sessions and your facts live in TAILOR_MCP_DATA (~/.resume-tailor).
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ProviderId } from "@resume-studio/llm";
import { defaultModelsFromEnv, providersFromEnv } from "@resume-studio/llm/env";
import { fileFactStore, fileSessionStore } from "@resume-studio/tailor/node";
import { createMcpServer } from "./server.ts";

const providers = providersFromEnv(process.env, { claudeCode: true });
const chosen = providers.find((p) => p.provider === (process.env.TAILOR_PROVIDER as ProviderId)) ?? providers[0];
const model = defaultModelsFromEnv()[chosen.provider];
if (!model) throw new Error(`Set TAILOR_MODEL for ${chosen.provider}`);
const data = process.env.TAILOR_MCP_DATA ?? join(homedir(), ".resume-tailor");

const server = createMcpServer({
  provider: { ...chosen, model },
  store: fileSessionStore(join(data, "sessions")),
  facts: fileFactStore(join(data, "facts.json")),
});
await server.connect(new StdioServerTransport());
// stdout carries the protocol: logs go to stderr.
console.error(`resume-tailor-mcp ready · ${chosen.provider} · ${model}`);
