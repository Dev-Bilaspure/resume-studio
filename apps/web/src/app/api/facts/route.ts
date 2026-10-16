import { z } from "zod";
import { body, handler, noStore } from "@/server/api";
import { readFacts, writeFacts } from "@/server/tailor";

/** Your fact bank (resumes/_profile/facts.json). */
export const GET = handler(async () => Response.json({ facts: await readFacts() }, { headers: noStore }));

const Facts = z.object({
  facts: z.array(z.object({ id: z.string(), text: z.string().trim().min(1).max(2000), skills: z.array(z.string()), source: z.enum(["answer", "manual", "import"]), createdAt: z.string() })),
});

export const PUT = handler(async (req: Request) => {
  await writeFacts((await body(req, Facts)).facts);
  return Response.json({ ok: true });
});
