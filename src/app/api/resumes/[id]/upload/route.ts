import { handler, param } from "@/server/api";
import { uploadFile } from "@/server/workspace";

type Ctx = { params: Promise<{ id: string }> };

/** Raw body upload: images, fonts, .cls files. ?path=images/logo.png */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await uploadFile(id, param(req, "path"), Buffer.from(await req.arrayBuffer()));
  return Response.json({ ok: true }, { status: 201 });
});
