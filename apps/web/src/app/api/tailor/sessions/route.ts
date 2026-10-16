import { z } from "zod";
import { body, handler, noStore } from "@/server/api";
import { listSessions, startTailoring } from "@/server/tailor";

export const GET = handler(async (req: Request) => {
  const resumeId = new URL(req.url).searchParams.get("resumeId") ?? undefined;
  return Response.json({ sessions: await listSessions(resumeId) }, { headers: noStore });
});

const Start = z.object({
  resumeId: z.string().min(1),
  job: z.object({
    company: z.string().trim().min(1, "Company is required").max(200),
    role: z.string().trim().min(1, "Role is required").max(200),
    seniority: z.enum(["intern", "junior", "mid", "senior", "staff", "principal", "manager"]).optional(),
    description: z.string().trim().min(80, "Paste the full job description").max(60_000),
    location: z.string().max(200).optional(),
    link: z.string().max(2000).optional(),
    notes: z.string().max(4000).optional(),
  }),
  options: z
    .object({ maxPages: z.number().int().min(1).max(4).optional(), allowHeadline: z.boolean().optional(), allowNewSkills: z.boolean().optional(), askQuestions: z.boolean().optional() })
    .optional(),
  provider: z.enum(["claude-code", "openai", "anthropic", "vertex"]).optional(),
  model: z.string().max(200).optional(),
});

/** Starts tailoring a resume to a job. It runs in the background; follow it with GET /:id or events. */
export const POST = handler(async (req: Request) => {
  const s = await startTailoring(await body(req, Start));
  return Response.json({ id: s.id }, { status: 201 });
});
