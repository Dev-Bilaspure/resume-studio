import { z } from "zod";
import { body, handler } from "@/server/api";
import { finalizeSession } from "@/server/tailor";

type Ctx = { params: Promise<{ id: string }> };

/** Saves the accepted edits as a new resume (with the job description and the session record). */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { accepted, name } = await body(req, z.object({ accepted: z.array(z.string()), name: z.string().trim().min(1).max(120) }));
  return Response.json(await finalizeSession(id, accepted, name), { status: 201 });
});
