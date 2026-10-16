import { handler } from "@/server/api";
import { compilerFor } from "@/server/runtime";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Recompile now, even if no file changed (e.g. after installing a package).
 * With {"clean": true}: clear the cached aux files first (Overleaf's "Clear cached files").
 */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { clean?: boolean };
  const c = await compilerFor(id);
  if (body.clean) void c.clean();
  else c.schedule(true);
  return Response.json({ ok: true }, { status: 202 });
});
