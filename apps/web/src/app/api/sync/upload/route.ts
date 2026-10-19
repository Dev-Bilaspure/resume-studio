import { handler, noStore } from "@/server/api";
import { uploadSync } from "@/server/sync";

/** Uploads what changed on this computer since the last sync. */
export const POST = handler(async () => Response.json(await uploadSync(), { headers: noStore }));
