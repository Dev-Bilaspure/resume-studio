import { z } from "zod";
import { body, handler, noStore } from "@/server/api";
import { HttpError } from "@/server/fsutil";
import type { ResumeMeta } from "@/lib/types";
import { dropCompiler } from "@/server/compiler";
import { emit } from "@/server/events";
import { compilerFor } from "@/server/runtime";
import { createSnapshot } from "@/server/snapshots";
import { tailoringRunFor } from "@/server/tailor";
import { getResume, listFiles, trashResume, updateResume } from "@/server/workspace";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const meta = await getResume(id);
  const [files, compiler] = await Promise.all([listFiles(id), compilerFor(id)]);
  const build = compiler.state();
  // First open after a restart, or a resume made outside the app: build it now.
  if (!build.last && !build.running) compiler.schedule();
  return Response.json({ meta, files, build: compiler.state() }, { headers: noStore });
});

const Patch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  engine: z.enum(["pdflatex", "xelatex", "lualatex", "latex"]).optional(),
  mainFile: z.string().min(1).optional(),
  trusted: z.boolean().optional(),
  haltOnError: z.boolean().optional(),
  /** Where the application for a tailored resume stands. */
  applicationStatus: z.enum(["draft", "applied", "interviewing", "offer", "rejected", "withdrawn"]).optional(),
});

export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { applicationStatus, ...patch } = await body(req, Patch);
  let application: ResumeMeta["application"];
  if (applicationStatus) {
    const current = (await getResume(id)).application;
    if (!current) throw new HttpError(400, "This resume wasn't tailored for a job");
    application = { ...current, status: applicationStatus };
  }
  const meta = await updateResume(id, { ...patch, application });
  emit({ type: "resumes" });
  (await compilerFor(id)).schedule(true);
  return Response.json(meta);
});

export const DELETE = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  await getResume(id);
  if (await tailoringRunFor(id)) {
    throw new HttpError(409, "A tailoring run is using this resume. Wait for it to finish, or stop it (it takes a few seconds to stop), then delete.");
  }
  // A build in progress would keep writing this resume's files: let it finish first.
  await (await compilerFor(id)).idle();
  // Snapshot first: the history keeps the resume even after the folder goes to the trash.
  await createSnapshot(id, { message: "Before deleting the resume", auto: true }).catch(() => null);
  await trashResume(id);
  dropCompiler(id);
  emit({ type: "resumes" });
  return new Response(null, { status: 204 });
});
