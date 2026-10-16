import { handler, intParam, noStore, param } from "@/server/api";
import { forwardSearch, inverseSearch } from "@/server/synctex";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Forward (source → PDF): ?build=&file=&line=[&column=]  → { boxes }
 * Inverse (PDF → source): ?build=&page=&x=&y=           → { file, line, column } | null
 * Coordinates are PostScript points from the page's top-left corner.
 */
export const GET = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const q = new URL(req.url).searchParams;
  const build = intParam(req, "build");
  if (q.has("page")) {
    return Response.json(await inverseSearch(id, build, intParam(req, "page"), intParam(req, "x"), intParam(req, "y")), { headers: noStore });
  }
  const boxes = await forwardSearch(id, build, param(req, "file"), intParam(req, "line"), Number(q.get("column") ?? 0));
  return Response.json({ boxes }, { headers: noStore });
});
