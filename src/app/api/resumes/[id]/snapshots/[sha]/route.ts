import { handler, noStore } from "@/server/api";
import { snapshotFile, snapshotFiles } from "@/server/snapshots";

type Ctx = { params: Promise<{ id: string; sha: string }> };

/** The files in a snapshot; with ?path=, one file's content (for the diff view). */
export const GET = handler(async (req: Request, { params }: Ctx) => {
  const { id, sha } = await params;
  const path = new URL(req.url).searchParams.get("path");
  if (path) return Response.json({ path, content: await snapshotFile(id, sha, path) }, { headers: noStore });
  return Response.json({ files: await snapshotFiles(id, sha) }, { headers: noStore });
});
