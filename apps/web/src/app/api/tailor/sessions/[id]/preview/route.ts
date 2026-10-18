import { z } from "zod";
import { body, handler } from "@/server/api";
import { previewSession } from "@/server/tailor";

type Ctx = { params: Promise<{ id: string }> };

/** Compiles the draft with only the accepted edits; returns a URL for its PDF. */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { accepted } = await body(req, z.object({ accepted: z.array(z.string()) }));
  const r = await previewSession(id, accepted);
  return Response.json({ url: r.pdf ? `/api/tailor/sessions/${id}/pdf/${r.pdf}` : null, pages: r.pages, atsScore: r.atsScore, errors: r.errors });
});
