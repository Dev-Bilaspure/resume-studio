import { z } from "zod";
import { body, handler, noStore } from "@/server/api";
import { connectSync } from "@/server/sync";

/** Connects a private repository to sync with: { url }. */
export const POST = handler(async (req: Request) => {
  const { url } = await body(req, z.object({ url: z.string().trim().min(1).max(500) }));
  return Response.json(await connectSync(url), { headers: noStore });
});
