import { readFile } from "node:fs/promises";
import { handler } from "@/server/api";
import { HttpError } from "@/server/fsutil";
import { previewPath } from "@/server/tailor";

type Ctx = { params: Promise<{ id: string; name: string }> };

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id, name } = await params;
  const data = await readFile(previewPath(id, name)).catch(() => {
    throw new HttpError(404, "Preview not found");
  });
  return new Response(new Uint8Array(data), { headers: { "Content-Type": "application/pdf", "Cache-Control": "private, max-age=31536000, immutable" } });
});
