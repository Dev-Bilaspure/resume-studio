import { readFile } from "node:fs/promises";
import { handler } from "@/server/api";
import { publishedPath } from "@/server/compiler";
import { HttpError } from "@/server/fsutil";
import { resumeDir } from "@/server/workspace";

type Ctx = { params: Promise<{ id: string; build: string }> };

// A build's PDF never changes (each build gets a new id), so the browser may cache it forever.
export const GET = handler(async (req: Request, { params }: Ctx) => {
  const { id, build } = await params;
  resumeDir(id);
  if (!/^\d+$/.test(build)) throw new HttpError(400, "Invalid build id");
  const data = await readFile(publishedPath(id, Number(build), "pdf")).catch(() => {
    throw new HttpError(404, "That build is gone; a newer one replaced it");
  });
  const download = new URL(req.url).searchParams.get("download");
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(data.byteLength),
      "Cache-Control": "private, max-age=31536000, immutable",
      ...(download ? { "Content-Disposition": `attachment; filename="${download.replace(/[^\w.\- ]/g, "_")}"` } : {}),
    },
  });
});
