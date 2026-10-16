"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { DOCUMENT_OPTIONS, loadPdfjs } from "./pdfjs";

/** First page of a PDF, rendered crisp at the element's width. */
export function PdfThumb({ url, className }: { url: string; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    let destroy: (() => void) | null = null;
    void (async () => {
      try {
        const { pdfjs } = await loadPdfjs();
        const task = pdfjs.getDocument({ url, ...DOCUMENT_OPTIONS });
        destroy = () => void task.destroy();
        const doc = await task.promise;
        const page = await doc.getPage(1);
        const el = canvas.current;
        if (cancelled || !el) return;
        const width = el.parentElement?.clientWidth || 240;
        const base = page.getViewport({ scale: 1 });
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: (width / base.width) * dpr });
        el.width = Math.floor(viewport.width);
        el.height = Math.floor(viewport.height);
        el.style.aspectRatio = `${base.width} / ${base.height}`;
        await page.render({ canvas: el, viewport }).promise;
        if (!cancelled) setState("ok");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [url]);

  return (
    <div className={cn("relative bg-white", className)}>
      <canvas ref={canvas} className={cn("block w-full transition-opacity duration-300", state === "ok" ? "opacity-100" : "opacity-0")} />
      {state !== "ok" && <div className="absolute inset-0 animate-pulse bg-white/90" />}
    </div>
  );
}
