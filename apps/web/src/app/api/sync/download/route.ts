import { z } from "zod";
import { body, handler, noStore } from "@/server/api";
import { downloadSync } from "@/server/sync";

/** Downloads what changed in the repository: { resolutions: { path: "local" | "remote" } } for files changed in both places. */
export const POST = handler(async (req: Request) => {
  const { resolutions } = await body(req, z.object({ resolutions: z.record(z.string(), z.enum(["local", "remote"])).default({}) }));
  return Response.json(await downloadSync(resolutions), { headers: noStore });
});
