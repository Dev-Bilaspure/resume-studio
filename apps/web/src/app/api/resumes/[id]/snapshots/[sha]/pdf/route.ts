import { readFile } from "node:fs/promises";
import { handler } from "@/server/api";
import { HttpError } from "@/server/fsutil";
import { snapshotPdfPath } from "@/server/snapshots";

type Ctx = { params: Promise<{ id: string; sha: string }> };

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id, sha } = await params;
  const data = await readFile(snapshotPdfPath(id, sha)).catch(() => {
    throw new HttpError(404, "Not rendered yet");
  });
  return new Response(new Uint8Array(data), {
    headers: { "Content-Type": "application/pdf", "Content-Length": String(data.byteLength), "Cache-Control": "private, max-age=31536000, immutable" },
  });
});
