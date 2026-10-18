import { handler } from "@/server/api";
import { retrySession } from "@/server/tailor";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  await retrySession(id);
  return Response.json({ ok: true }, { status: 202 });
});
