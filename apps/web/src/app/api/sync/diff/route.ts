import { z } from "zod";
import { handler, noStore } from "@/server/api";
import { syncDiff } from "@/server/sync";

const Query = z.object({ path: z.string().min(1).max(1024), side: z.enum(["local", "remote", "conflict"]) });

/** One file's changes: ?path=&side=local|remote|conflict. */
export const GET = handler(async (req: Request) => {
  const q = Query.parse(Object.fromEntries(new URL(req.url).searchParams));
  return Response.json(await syncDiff(q.path, q.side), { headers: noStore });
});
