import { handler, noStore } from "@/server/api";
import { previewSnapshot } from "@/server/snapshots";

type Ctx = { params: Promise<{ id: string; sha: string }> };

/** Compiles the snapshot (once, then cached) so it can be viewed without restoring it. */
export const POST = handler(async (_req: Request, { params }: Ctx) => {
  const { id, sha } = await params;
  return Response.json(await previewSnapshot(id, sha), { headers: noStore });
});
