import { handler, noStore } from "@/server/api";
import { getSession } from "@/server/tailor";

type Ctx = { params: Promise<{ id: string }> };

/** The session as the review screen needs it (without the raw source and draft files). */
export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  // Raw source and draft files stay on the server (undefined fields are left out of the JSON).
  const s = { ...(await getSession(id)), source: undefined, draft: undefined };
  if (s.report) {
    s.report = {
      ...s.report,
      before: { ...s.report.before, build: s.report.before.build && { ...s.report.before.build, text: undefined } },
      after: { ...s.report.after, build: s.report.after.build && { ...s.report.after.build, text: undefined } },
    };
  }
  return Response.json(s, { headers: noStore });
});
