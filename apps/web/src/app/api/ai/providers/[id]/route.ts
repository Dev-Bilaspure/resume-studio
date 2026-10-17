import { z } from "zod";
import type { ProviderId } from "@resume-studio/llm";
import { body, handler } from "@/server/api";
import { saveProvider } from "@/server/ai-config";

type Ctx = { params: Promise<{ id: string }> };

const Save = z.object({ model: z.string().max(200).optional(), values: z.record(z.string(), z.string().max(20_000)), makeDefault: z.boolean().optional() });

/** Saves a provider's settings. Secret values go to the secret store (the macOS Keychain, or .resume-studio/secrets.json elsewhere); "" clears one. */
export const PUT = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const update = await body(req, Save);
  return Response.json(await saveProvider(id as ProviderId, update as Parameters<typeof saveProvider>[1]));
});
