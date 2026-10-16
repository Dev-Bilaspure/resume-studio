import { handler } from "@/server/api";
import { subscribe } from "@/server/events";

// Server-sent events: build results, file changes on disk, resume list and snapshot changes.
// One stream per open tab; the browser's EventSource reconnects by itself if it drops.
export const GET = handler(async (req: Request) => {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          cleanup();
        }
      };
      send("retry: 1500\n\n");
      const unsubscribe = subscribe((e) => send(`data: ${JSON.stringify(e)}\n\n`));
      // Comments keep proxies and the browser from timing the connection out.
      const ping = setInterval(() => send(": ping\n\n"), 15_000);
      cleanup = () => {
        clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      req.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
