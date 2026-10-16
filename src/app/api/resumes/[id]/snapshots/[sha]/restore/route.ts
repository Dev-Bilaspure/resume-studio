import { handler } from "@/server/api";
import { compilerFor } from "@/server/runtime";
import { restoreSnapshot } from "@/server/snapshots";

type Ctx = { params: Promise<{ id: string; sha: string }> };

export const POST = handler(async (_req: Request, { params }: Ctx) => {
  const { id, sha } = await params;
  await restoreSnapshot(id, sha);
  (await compilerFor(id)).schedule(true);
  return Response.json({ ok: true });
});
