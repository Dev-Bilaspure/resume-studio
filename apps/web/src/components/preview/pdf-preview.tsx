"use client";

import "pdfjs-dist/legacy/web/pdf_viewer.css";
import { ChevronDown, ChevronUp, Minus, Plus, Search, X } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DOCUMENT_OPTIONS, loadPdfjs } from "./pdfjs";

type ViewerLib = typeof import("pdfjs-dist/legacy/web/pdf_viewer.mjs");
type Viewer = InstanceType<ViewerLib["PDFViewer"]>;
type EventBus = InstanceType<ViewerLib["EventBus"]>;

export interface SyncBox {
  page: number;
  h: number;
  v: number;
  width: number;
  height: number;
}

export interface PdfPreviewHandle {
  /** Scrolls to and briefly highlights boxes found by SyncTeX forward search. */
  highlight(boxes: SyncBox[]): void;
}

interface Props {
  url: string | null;
  /** Double-click on the page → SyncTeX inverse search (points from the page's top-left). */
  onInverseSync?(page: number, x: number, y: number): void;
  onError?(message: string): void;
  onLoaded?(info: { pages: number }): void;
  /** Rendered at the right of the preview toolbar. */
  toolbarExtra?: React.ReactNode;
  className?: string;
}

interface Layer {
  container: HTMLDivElement;
  eventBus: EventBus;
  viewer: Viewer;
  doc: PDFDocumentProxy | null;
  /** A document is being loaded into this layer (don't tear it down). */
  busy: boolean;
  linkService: InstanceType<ViewerLib["PDFLinkService"]>;
  findController: InstanceType<ViewerLib["PDFFindController"]>;
}

const ZOOM_PRESETS = [
  { value: "page-width", label: "Fit width" },
  { value: "page-fit", label: "Fit page" },
];
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const ZOOM_KEY = "rs.preview.zoom";

function storedZoom(): string {
  try {
    return localStorage.getItem(ZOOM_KEY) || "page-width";
  } catch {
    return "page-width";
  }
}

/**
 * The PDF preview. Two stacked PDF.js viewers: a new build renders in the hidden one at the same zoom
 * and scroll position, and the two swap only once its visible pages have painted. The page never goes
 * blank or jumps while you type.
 */
export const PdfPreview = forwardRef<PdfPreviewHandle, Props>(function PdfPreview({ url, onInverseSync, onError, onLoaded, toolbarExtra, className }, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const hostA = useRef<HTMLDivElement>(null);
  const hostB = useRef<HTMLDivElement>(null);
  const layers = useRef<Layer[] | null>(null);
  const front = useRef(0); // index of the visible layer
  const generation = useRef(0);
  const zoom = useRef<string>("page-width");
  const cbs = useRef({ onInverseSync, onError, onLoaded });
  const [ready, setReady] = useState(false);
  const [hasDoc, setHasDoc] = useState(false);
  const [page, setPage] = useState({ current: 1, total: 0 });
  const [pageInput, setPageInput] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
  const findInput = useRef<HTMLInputElement>(null);
  const queryRef = useRef("");
  const [scaleLabel, setScaleLabel] = useState("Fit width");

  useEffect(() => {
    cbs.current = { onInverseSync, onError, onLoaded };
  });

  const updateScaleLabel = useCallback((viewer: Viewer) => {
    const preset = ZOOM_PRESETS.find((p) => p.value === zoom.current);
    setScaleLabel(preset ? preset.label : `${Math.round(viewer.currentScale * 100)}%`);
  }, []);

  // ---- Set up both viewers once ------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    zoom.current = storedZoom();
    void loadPdfjs().then(({ pdfjs, viewer: lib }) => {
      if (cancelled || !hostA.current || !hostB.current) return;
      layers.current = [hostA.current, hostB.current].map((container, i) => {
        const eventBus = new lib.EventBus();
        const linkService = new lib.PDFLinkService({ eventBus, externalLinkTarget: lib.LinkTarget.BLANK, externalLinkRel: "noopener noreferrer nofollow" });
        const findController = new lib.PDFFindController({ linkService, eventBus });
        const viewer = new lib.PDFViewer({
          findController,
          container,
          viewer: container.firstElementChild as HTMLDivElement,
          eventBus,
          linkService,
          removePageBorders: true,
          textLayerMode: 1,
          annotationMode: pdfjs.AnnotationMode.ENABLE,
          maxCanvasPixels: 2 ** 25,
          enableAutoLinking: false,
        });
        linkService.setViewer(viewer);
        const onMatches = ({ matchesCount }: { matchesCount: { current: number; total: number } }) => {
          if (front.current === i) setMatches(matchesCount);
        };
        eventBus.on("updatefindmatchescount", onMatches);
        eventBus.on("updatefindcontrolstate", onMatches);
        eventBus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
          if (front.current === i) setPage((p) => ({ ...p, current: pageNumber }));
        });
        eventBus.on("scalechanging", () => {
          if (front.current === i) updateScaleLabel(viewer);
        });
        return { container, eventBus, viewer, doc: null, busy: false, linkService, findController };
      });
      setReady(true);
    });
    return () => {
      cancelled = true;
      for (const l of layers.current ?? []) {
        l.viewer.setDocument(null as unknown as PDFDocumentProxy);
        void l.doc?.loadingTask.destroy();
      }
      layers.current = null;
    };
  }, [updateScaleLabel]);

  // ---- Load a new PDF into the back layer, then swap -------------------------------------------------------
  useEffect(() => {
    if (!ready || !layers.current) return;
    const gen = ++generation.current;
    const ls = layers.current;
    if (!url) return;

    let cancelled = false;
    void (async () => {
      const { pdfjs } = await loadPdfjs();
      const cur = ls[front.current];
      const backIdx = cur.doc ? 1 - front.current : front.current;
      const back = ls[backIdx];
      let doc: PDFDocumentProxy;
      try {
        doc = await pdfjs.getDocument({ url, ...DOCUMENT_OPTIONS }).promise;
      } catch (e) {
        if (!cancelled) cbs.current.onError?.((e as Error).message || "Couldn't load the PDF");
        return;
      }
      if (cancelled || gen !== generation.current) {
        void doc.loadingTask.destroy();
        return;
      }

      const inited = new Promise<void>((res) => back.eventBus.on("pagesinit", () => res(), { once: true }));
      back.busy = true;
      back.viewer.setDocument(doc);
      // Internal links (\\ref, table of contents) and search need the document too.
      back.linkService.setDocument(doc, null);
      back.findController.setDocument(doc);
      await inited;
      if (cancelled || gen !== generation.current) {
        back.busy = false;
        if (!back.doc) back.viewer.setDocument(null as unknown as PDFDocumentProxy);
        void doc.loadingTask.destroy();
        return;
      }
      back.viewer.currentScaleValue = zoom.current;

      if (backIdx !== front.current) {
        // Same zoom, same place.
        back.container.scrollTop = cur.container.scrollTop;
        back.container.scrollLeft = cur.container.scrollLeft;
        await new Promise<void>((res) => {
          const t = setTimeout(res, 700);
          back.eventBus.on("pagerendered", () => (clearTimeout(t), res()), { once: true });
        });
        if (cancelled || gen !== generation.current) {
          back.busy = false;
          void doc.loadingTask.destroy();
          return;
        }
        back.container.dataset.active = "true";
        cur.container.dataset.active = "false";
        front.current = backIdx;
        const old = cur.doc;
        cur.doc = null;
        // Let the swap paint before tearing down the old document.
        setTimeout(() => {
          if (!cur.doc && !cur.busy) cur.viewer.setDocument(null as unknown as PDFDocumentProxy);
          void old?.loadingTask.destroy();
        }, 150);
      } else {
        back.container.dataset.active = "true";
      }
      back.doc = doc;
      back.busy = false;
      // Keep an active search highlighted in the new build.
      if (queryRef.current)
        back.eventBus.dispatch("find", {
          source: null,
          type: "",
          query: queryRef.current,
          caseSensitive: false,
          entireWord: false,
          highlightAll: true,
          findPrevious: false,
          matchDiacritics: false,
        });
      setHasDoc(true);
      setPage({ current: back.viewer.currentPageNumber, total: doc.numPages });
      updateScaleLabel(back.viewer);
      cbs.current.onLoaded?.({ pages: doc.numPages });
    })();
    return () => {
      cancelled = true;
    };
  }, [url, ready, updateScaleLabel]);

  // ---- Zoom -----------------------------------------------------------------------------------------------
  const active = () => layers.current?.[front.current];

  const setZoom = useCallback(
    (value: string) => {
      zoom.current = value;
      try {
        localStorage.setItem(ZOOM_KEY, value);
      } catch {
        // Not persisted; fine.
      }
      for (const l of layers.current ?? []) if (l.doc) l.viewer.currentScaleValue = value;
      const a = active();
      if (a) updateScaleLabel(a.viewer);
    },
    [updateScaleLabel],
  );

  const step = (dir: 1 | -1) => {
    const a = active();
    if (!a?.doc) return;
    const cur = a.viewer.currentScale;
    const next =
      dir > 0 ? (ZOOM_STEPS.find((s) => s > cur + 0.001) ?? ZOOM_STEPS.at(-1)!) : ([...ZOOM_STEPS].reverse().find((s) => s < cur - 0.001) ?? ZOOM_STEPS[0]);
    setZoom(String(next));
  };

  // Fit modes follow the pane size; ⌘/ctrl + wheel and trackpad pinch zoom around the pointer.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!ZOOM_PRESETS.some((p) => p.value === zoom.current)) return;
      for (const l of layers.current ?? []) if (l.doc) l.viewer.currentScaleValue = zoom.current;
    });
    ro.observe(el);
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const a = active();
      if (!a?.doc) return;
      const factor = Math.exp(-e.deltaY / (e.deltaMode === 1 ? 20 : 300));
      a.viewer.updateScale({ scaleFactor: factor, origin: [e.clientX, e.clientY], drawingDelay: 120 });
      zoom.current = String(a.viewer.currentScale);
      const other = layers.current?.[1 - front.current];
      if (other?.doc) other.viewer.currentScale = a.viewer.currentScale;
      try {
        localStorage.setItem(ZOOM_KEY, zoom.current);
      } catch {
        // ignore
      }
      updateScaleLabel(a.viewer);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, [updateScaleLabel]);

  // ---- Find in PDF and go to page ---------------------------------------------------------------------------
  const find = (type: "" | "again", findPrevious = false, q = query) => {
    queryRef.current = q;
    const a = active();
    if (!a?.doc) return;
    if (!q) {
      a.eventBus.dispatch("findbarclose", { source: null });
      setMatches({ current: 0, total: 0 });
      return;
    }
    a.eventBus.dispatch("find", {
      source: null,
      type,
      query: q,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
      matchDiacritics: false,
    });
  };

  const goToPage = (n: number) => {
    const a = active();
    if (!a?.doc || !Number.isFinite(n)) return;
    a.viewer.currentPageNumber = Math.max(1, Math.min(a.doc.numPages, Math.round(n)));
  };

  // ⌘F inside the preview searches the PDF (in the editor it searches the source).
  useEffect(() => {
    const el = wrap.current?.parentElement;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setFindOpen(true);
        setTimeout(() => findInput.current?.select(), 0);
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);

  // ---- SyncTeX ----------------------------------------------------------------------------------------------
  const onDoubleClick = (e: React.MouseEvent) => {
    const a = active();
    const pageEl = (e.target as HTMLElement).closest<HTMLElement>(".page");
    if (!a?.doc || !pageEl) return;
    const n = Number(pageEl.dataset.pageNumber);
    const view = a.viewer.getPageView(n - 1) as {
      viewport: { convertToPdfPoint(x: number, y: number): number[] };
      pdfPage: { view: number[] };
      div: HTMLDivElement;
    };
    const rect = view.div.getBoundingClientRect();
    const [px, py] = view.viewport.convertToPdfPoint(e.clientX - rect.left, e.clientY - rect.top);
    const [x0, , , y1] = view.pdfPage.view;
    window.getSelection()?.removeAllRanges();
    cbs.current.onInverseSync?.(n, px - x0, y1 - py);
  };

  useImperativeHandle(ref, () => ({
    highlight(boxes) {
      const a = active();
      if (!a?.doc || !boxes.length) return;
      const first = boxes[0];
      let scrollTo: number | null = null;
      for (const b of boxes.filter((x) => x.page === first.page)) {
        const view = a.viewer.getPageView(b.page - 1) as {
          viewport: { convertToViewportPoint(x: number, y: number): number[] };
          pdfPage: { view: number[] };
          div: HTMLDivElement;
        };
        if (!view?.div) continue;
        const [x0, , , y1] = view.pdfPage.view;
        const height = b.height || 10;
        const width = b.width || 40;
        // SyncTeX: h = left edge, v = baseline from the top, H = height above it (points). PDF space is
        // bottom-up, so the box spans y1 - v (baseline) to y1 - v + H (top).
        const [ax, ay] = view.viewport.convertToViewportPoint(x0 + b.h, y1 - b.v);
        const [bx, by] = view.viewport.convertToViewportPoint(x0 + b.h + width, y1 - b.v + height);
        const mark = document.createElement("div");
        mark.className = "sync-highlight";
        Object.assign(mark.style, {
          left: `${Math.min(ax, bx) - 3}px`,
          top: `${Math.min(ay, by) - 2}px`,
          width: `${Math.abs(bx - ax) + 6}px`,
          height: `${Math.abs(by - ay) + 4}px`,
        });
        view.div.appendChild(mark);
        setTimeout(() => mark.remove(), 1800);
        const top = view.div.offsetTop + Math.min(ay, by);
        scrollTo = scrollTo === null ? top : Math.min(scrollTo, top);
      }
      if (scrollTo !== null) {
        const c = a.container;
        const target = scrollTo - c.clientHeight / 3;
        const visible = scrollTo > c.scrollTop + 40 && scrollTo < c.scrollTop + c.clientHeight - 40;
        if (!visible) c.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
      }
    },
  }));

  return (
    // Focusable (not tabbable) so ⌘F after clicking the PDF searches the PDF.
    <div tabIndex={-1} className={cn("flex h-full min-h-0 flex-col outline-none", className)}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Zoom out" disabled={!hasDoc} onClick={() => step(-1)} />}>
            <Minus />
          </TooltipTrigger>
          <TooltipContent>Zoom out</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="sm" className="min-w-[5.5rem] justify-between font-normal tabular-nums" disabled={!hasDoc} />}
          >
            {scaleLabel}
            <ChevronDown className="opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-36">
            {ZOOM_PRESETS.map((p) => (
              <DropdownMenuItem key={p.value} onClick={() => setZoom(p.value)}>
                {p.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {[0.75, 1, 1.25, 1.5, 2].map((s) => (
              <DropdownMenuItem key={s} onClick={() => setZoom(String(s))}>
                {Math.round(s * 100)}%
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Zoom in" disabled={!hasDoc} onClick={() => step(1)} />}>
            <Plus />
          </TooltipTrigger>
          <TooltipContent>Zoom in</TooltipContent>
        </Tooltip>
        {hasDoc && page.total > 0 && (
          <form
            className="ml-2 flex items-center gap-1 text-xs text-muted-foreground tabular-nums"
            onSubmit={(e) => {
              e.preventDefault();
              goToPage(Number(pageInput));
              setPageInput(null);
            }}
          >
            Page
            <input
              aria-label="Page number"
              value={pageInput ?? String(page.current)}
              onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
              onFocus={(e) => e.target.select()}
              onBlur={() => setPageInput(null)}
              className="h-6 w-8 rounded border border-input bg-transparent text-center text-foreground outline-none focus:border-ring"
            />
            of {page.total}
          </form>
        )}
        <div className="ml-auto flex items-center gap-1">
          {findOpen ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                find("again");
              }}
            >
              <input
                ref={findInput}
                autoFocus
                value={query}
                placeholder="Find in PDF"
                aria-label="Find in PDF"
                onChange={(e) => {
                  setQuery(e.target.value);
                  find("", false, e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setFindOpen(false);
                    setQuery("");
                    find("", false, "");
                  } else if (e.key === "Enter" && e.shiftKey) {
                    e.preventDefault();
                    find("again", true);
                  }
                }}
                className="h-7 w-40 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:border-ring"
              />
              <span className="w-14 text-center text-[11px] text-muted-foreground tabular-nums">
                {query ? (matches.total ? `${matches.current}/${matches.total}` : "none") : ""}
              </span>
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Previous match" onClick={() => find("again", true)}>
                <ChevronUp />
              </Button>
              <Button type="submit" variant="ghost" size="icon-xs" aria-label="Next match">
                <ChevronDown />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Close search"
                onClick={() => {
                  setFindOpen(false);
                  setQuery("");
                  find("", false, "");
                }}
              >
                <X />
              </Button>
            </form>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Find in PDF"
                    disabled={!hasDoc}
                    onClick={() => {
                      setFindOpen(true);
                    }}
                  />
                }
              >
                <Search />
              </TooltipTrigger>
              <TooltipContent>Find in PDF (⌘F)</TooltipContent>
            </Tooltip>
          )}
          {toolbarExtra}
        </div>
      </div>
      <div ref={wrap} className="pdf-stage relative min-h-0 flex-1 bg-[var(--canvas)]" onDoubleClick={onDoubleClick}>
        {[hostA, hostB].map((h, i) => (
          <div key={i} ref={h} data-active={i === 0 ? "true" : "false"} className="pdf-layer absolute inset-0 overflow-auto">
            <div className="pdfViewer" />
          </div>
        ))}
      </div>
    </div>
  );
});
