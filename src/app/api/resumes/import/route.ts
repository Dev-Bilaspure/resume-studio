import { handler } from "@/server/api";
import { emit } from "@/server/events";
import { importZip } from "@/server/project-io";
import { compilerFor } from "@/server/runtime";

/** Raw .zip body (e.g. Overleaf → Menu → Download → Source). ?name=Display name */
export const POST = handler(async (req: Request) => {
  const name = new URL(req.url).searchParams.get("name") ?? "";
  const id = await importZip(name.trim(), Buffer.from(await req.arrayBuffer()));
  emit({ type: "resumes" });
  (await compilerFor(id)).schedule(true);
  return Response.json({ id }, { status: 201 });
});
