import { z } from "zod";
import { LLMError, testConnection, type ProviderId } from "@resume-studio/llm";
import { body, handler } from "@/server/api";
import { resolveProvider } from "@/server/ai-config";

type Ctx = { params: Promise<{ id: string }> };

const Test = z.object({ model: z.string().optional(), values: z.record(z.string(), z.string()).optional() });

/** Sends one tiny structured request with the saved settings (or the unsaved values in the form). */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { model, values } = await body(req, Test);
  const config = await resolveProvider(id as ProviderId, { model, values: values as never });
  try {
    return Response.json(await testConnection(config, req.signal));
  } catch (e) {
    const err = e instanceof LLMError ? e : new LLMError("unknown", (e as Error).message, false, config.provider);
    return Response.json({ ok: false, kind: err.kind, error: err.message }, { status: 200 });
  }
});
