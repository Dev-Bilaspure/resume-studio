import { handler, noStore } from "@/server/api";
import { projectSymbols } from "@/server/project-io";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  return Response.json(await projectSymbols(id), { headers: noStore });
});
