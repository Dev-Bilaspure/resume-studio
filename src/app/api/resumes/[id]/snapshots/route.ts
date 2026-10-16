import { z } from "zod";
import { body, handler, noStore, param } from "@/server/api";
import { createSnapshot, listSnapshots, removeLabel } from "@/server/snapshots";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  return Response.json({ snapshots: await listSnapshots(id) }, { headers: noStore });
});

const Create = z.object({ message: z.string().max(200).optional(), label: z.string().max(60).optional() });

export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const snap = await createSnapshot(id, await body(req, Create));
  return Response.json(snap, { status: 201 });
});

/** ?label=sent-to-acme removes a label (the snapshot itself stays). */
export const DELETE = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await removeLabel(id, param(req, "label"));
  return new Response(null, { status: 204 });
});
