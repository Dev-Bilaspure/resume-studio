import { z } from "zod";
import { body, handler, noStore } from "@/server/api";
import { readPreferences, writePreferences } from "@/server/preferences";

/** Your preferences, as last mirrored from the browser. */
export const GET = handler(async () => Response.json(await readPreferences(), { headers: noStore }));

/** Replaces them with the browser's current ones: { values: { "rs.editor": "…" } }. */
export const PUT = handler(async (req: Request) => {
  const { values } = await body(req, z.object({ values: z.record(z.string(), z.string()) }));
  return Response.json(await writePreferences(values), { headers: noStore });
});
