import { handler } from "@/server/api";
import { cancelSession } from "@/server/tailor";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  cancelSession(id);
  return Response.json({ ok: true });
});
