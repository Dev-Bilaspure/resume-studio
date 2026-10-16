import { z } from "zod";
import { body, handler } from "@/server/api";
import { labelSnapshot } from "@/server/snapshots";

type Ctx = { params: Promise<{ id: string; sha: string }> };

export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id, sha } = await params;
  await labelSnapshot(id, sha, (await body(req, z.object({ label: z.string().trim().min(1).max(60) }))).label);
  return Response.json({ ok: true });
});
