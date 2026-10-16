import { handler, noStore } from "@/server/api";
import { listOutputFiles, readOutputFile } from "@/server/project-io";

type Ctx = { params: Promise<{ id: string }> };

const TEXT = /\.(log|blg|aux|bbl|fls|toc|out|lof|lot|bcf|run\.xml|ilg|ind|idx|glg|gls|glo|nls|nlo|fdb_latexmk|synctex)$/;

/** The build's files; ?file=main.log returns one (text inline, others as a download). */
export const GET = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const file = new URL(req.url).searchParams.get("file");
  if (!file) return Response.json({ files: await listOutputFiles(id) }, { headers: noStore });
  const data = await readOutputFile(id, file);
  const download = new URL(req.url).searchParams.has("download") || !TEXT.test(file);
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": TEXT.test(file) ? "text/plain; charset=utf-8" : "application/octet-stream",
      "Content-Security-Policy": "sandbox",
      ...(download ? { "Content-Disposition": `attachment; filename="${file.replace(/[^\w.\-]/g, "_")}"` } : {}),
      ...noStore,
    },
  });
});
