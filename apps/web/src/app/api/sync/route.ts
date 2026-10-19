import { handler, noStore } from "@/server/api";
import { disconnectSync, syncStatus } from "@/server/sync";

/** Sync status. ?check=1 first asks the repository what's new (network). */
export const GET = handler(async (req: Request) => {
  const check = new URL(req.url).searchParams.get("check") === "1";
  return Response.json(await syncStatus(check), { headers: noStore });
});

/** Disconnects this computer from the repository. Your files and the repository are left as they are. */
export const DELETE = handler(async () => {
  await disconnectSync();
  return Response.json(await syncStatus(), { headers: noStore });
});
