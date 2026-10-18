import { PROVIDERS } from "@resume-studio/llm";
import { z } from "zod";
import { body, handler, noStore } from "@/server/api";
import { getAiSettings, setDefaultProvider } from "@/server/ai-config";

/** The provider catalog (fields, suggested models) and your saved settings (secrets as set/unset only). */
export const GET = handler(async () => Response.json({ catalog: PROVIDERS, settings: await getAiSettings() }, { headers: noStore }));

export const PUT = handler(async (req: Request) => {
  const { defaultProvider } = await body(req, z.object({ defaultProvider: z.enum(["claude-code", "openai", "anthropic", "vertex"]) }));
  await setDefaultProvider(defaultProvider);
  return Response.json(await getAiSettings());
});
