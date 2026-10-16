import { z } from "zod";
import { body, handler, noStore } from "@/server/api";
import { emit } from "@/server/events";
import { compilerFor } from "@/server/runtime";
import { createResume, listResumes, listTemplates } from "@/server/workspace";

export const GET = handler(async () => {
  const resumes = await Promise.all(
    (await listResumes()).map(async (meta) => {
      const { lastGood, last } = (await compilerFor(meta.id)).state();
      return {
        ...meta,
        build: {
          score: lastGood?.ats && !lastGood.ats.unavailable ? lastGood.ats.score : null,
          pages: lastGood?.pages ?? null,
          pdfUrl: lastGood?.pdfUrl ?? null,
          status: last?.status ?? null,
        },
      };
    }),
  );
  return Response.json({ resumes, templates: await listTemplates() }, { headers: noStore });
});

const Create = z.object({
  name: z.string().trim().min(1, "Give the resume a name").max(120),
  template: z.string().optional(),
  duplicateOf: z.string().optional(),
});

export const POST = handler(async (req: Request) => {
  const input = await body(req, Create);
  const meta = await createResume(input);
  emit({ type: "resumes" });
  (await compilerFor(meta.id)).schedule(true);
  return Response.json(meta, { status: 201 });
});
