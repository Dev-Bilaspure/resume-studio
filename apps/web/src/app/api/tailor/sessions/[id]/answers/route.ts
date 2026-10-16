import { z } from "zod";
import { body, handler } from "@/server/api";
import { answerSession } from "@/server/tailor";

type Ctx = { params: Promise<{ id: string }> };

const Answers = z.object({ answers: z.array(z.object({ questionId: z.string(), text: z.string().max(4000).optional(), none: z.boolean().optional() })) });

/** Your answers (an empty list skips the questions); writing continues in the background. */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await answerSession(id, (await body(req, Answers)).answers);
  return Response.json({ ok: true }, { status: 202 });
});
