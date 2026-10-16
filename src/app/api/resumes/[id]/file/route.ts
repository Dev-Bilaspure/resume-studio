import { z } from "zod";
import { body, handler, noStore, param } from "@/server/api";
import { compilerFor } from "@/server/runtime";
import { createEntry, deleteEntry, readBinary, readTextFile, renameEntry, touchResume, writeTextFile } from "@/server/workspace";

type Ctx = { params: Promise<{ id: string }> };

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  webp: "image/webp",
};

/** ?path=main.tex → text content and hash. With &raw=1, the bytes (images, fonts). */
export const GET = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const path = param(req, "path");
  if (new URL(req.url).searchParams.get("raw")) {
    const { data, size } = await readBinary(id, path);
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return new Response(new Uint8Array(data), {
      headers: { "Content-Type": MIME[ext] ?? "application/octet-stream", "Content-Length": String(size), "Content-Security-Policy": "sandbox", ...noStore },
    });
  }
  return Response.json(await readTextFile(id, path), { headers: noStore });
});

const Save = z.object({ content: z.string(), baseHash: z.string().nullable() });

/** Saves a text file, refusing (409) if it changed on disk since `baseHash`. Triggers a build. */
export const PUT = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const path = param(req, "path");
  const { content, baseHash } = await body(req, Save);
  const saved = await writeTextFile(id, path, content, baseHash);
  // Build right away rather than waiting for the file watcher to notice.
  (await compilerFor(id)).schedule();
  void touchResume(id).catch(() => {});
  return Response.json({ path: saved.path, hash: saved.hash, mtimeMs: saved.mtimeMs });
});

const Create = z.object({ kind: z.enum(["file", "dir"]), content: z.string().optional() });

export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { kind, content } = await body(req, Create);
  await createEntry(id, param(req, "path"), kind, content ?? "");
  return Response.json({ ok: true }, { status: 201 });
});

const Rename = z.object({ to: z.string().min(1) });

export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await renameEntry(id, param(req, "path"), (await body(req, Rename)).to);
  return Response.json({ ok: true });
});

export const DELETE = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await deleteEntry(id, param(req, "path"));
  return new Response(null, { status: 204 });
});
