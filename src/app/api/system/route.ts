import { handler, noStore } from "@/server/api";
import { systemStatus } from "@/server/runtime";

export const GET = handler(async () => Response.json(await systemStatus(), { headers: noStore }));
