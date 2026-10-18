import { handler } from "@/server/api";
import { exportZip } from "@/server/project-io";
import { getResume } from "@/server/workspace";

type Ctx = { params: Promise<{ id: string }> };

/** The project source as a .zip (uploadable to Overleaf as a new project). */
export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  await getResume(id);
  const data = await exportZip(id);
  return new Response(new Uint8Array(data), {
    headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${id}.zip"`, "Cache-Control": "no-store" },
  });
});
