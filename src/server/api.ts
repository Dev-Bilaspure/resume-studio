import "server-only";
import { z } from "zod";
import { HttpError } from "./fsutil";
import { ensureRuntime } from "./runtime";

/** Wraps a route handler: starts the runtime, maps HttpError/zod errors to JSON responses. */
export function handler<C>(fn: (req: Request, ctx: C) => Promise<Response>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      await ensureRuntime();
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof HttpError) {
        const extra = (e as HttpError & { current?: string }).current;
        return Response.json({ error: e.message, ...(extra ? { current: extra } : {}) }, { status: e.status });
      }
      if (e instanceof z.ZodError) {
        return Response.json({ error: e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, { status: 400 });
      }
      console.error("[resume-studio]", e);
      return Response.json({ error: (e as Error).message ?? "Internal error" }, { status: 500 });
    }
  };
}

export async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
  return schema.parse(json);
}

/** A required query parameter. */
export function param(req: Request, name: string): string {
  const v = new URL(req.url).searchParams.get(name);
  if (!v) throw new HttpError(400, `Missing "${name}"`);
  return v;
}

export function intParam(req: Request, name: string): number {
  const n = Number(param(req, name));
  if (!Number.isFinite(n)) throw new HttpError(400, `"${name}" must be a number`);
  return n;
}

export const noStore = { "Cache-Control": "no-store" };
