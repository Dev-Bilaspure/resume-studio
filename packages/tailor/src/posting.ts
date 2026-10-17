// Reads a pasted job posting's basic details (company, title, level, location), so a form or a tool
// needs nothing but the posting. One small model call; nothing is guessed that the posting doesn't say.
import type { LLM } from "@resume-studio/llm";
import { PostingSchema, postingPrompt, type PostingDetails } from "./prompts.ts";

export type { PostingDetails };

export async function readPosting(llm: LLM, text: string, signal?: AbortSignal): Promise<PostingDetails> {
  const res = await llm.generate({ ...postingPrompt(text), schema: PostingSchema, schemaName: "posting_details", temperature: 0, maxOutputTokens: 1_000, signal, step: "read-posting" });
  const d = res.data;
  const clean = (v: string | null) => (v && v.trim() ? v.trim() : null);
  const role = clean(d.role);
  return { ...d, company: clean(d.company), role, suggestedRole: clean(d.suggestedRole) ?? role ?? "Software Engineer", location: clean(d.location) };
}
