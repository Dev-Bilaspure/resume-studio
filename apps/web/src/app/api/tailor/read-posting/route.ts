import { z } from "zod";
import { readPosting, type PostingDetails } from "@resume-studio/tailor";
import { body, handler } from "@/server/api";
import { llmFor } from "@/server/tailor";

/** A pasted posting's company, title, level and location, to fill the form. One small model call. */
export const POST = handler(async (req: Request) => {
  const input = await body(
    req,
    z.object({
      description: z.string().trim().min(80).max(60_000),
      provider: z.enum(["claude-code", "openai", "anthropic", "vertex"]).optional(),
      model: z.string().max(200).optional(),
    }),
  );
  const details: PostingDetails = await readPosting(await llmFor(input.provider, input.model), input.description, req.signal);
  return Response.json(details);
});
