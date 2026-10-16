import { handler, noStore } from "@/server/api";
import { wordCount } from "@/server/project-io";
import { getResume } from "@/server/workspace";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const meta = await getResume(id);
  return Response.json(await wordCount(id, meta.mainFile), { headers: noStore });
});
