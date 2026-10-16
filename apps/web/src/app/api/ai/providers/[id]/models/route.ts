import { z } from "zod";
import { LLMError, listModels, type ProviderId } from "@resume-studio/llm";
import { body, handler } from "@/server/api";
import { resolveProvider } from "@/server/ai-config";

type Ctx = { params: Promise<{ id: string }> };

/** Models this account can use (OpenAI, Anthropic list them), or the suggestions. */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { values } = await body(req, z.object({ values: z.record(z.string(), z.string()).optional() }));
  const config = await resolveProvider(id as ProviderId, { values: values as never });
  try {
    return Response.json({ models: await listModels(config, req.signal) });
  } catch (e) {
    return Response.json({ models: [], error: e instanceof LLMError ? e.message : (e as Error).message });
  }
});
