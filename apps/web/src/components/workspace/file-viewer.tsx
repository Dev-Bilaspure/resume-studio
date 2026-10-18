"use client";

import { Download, FileQuestion } from "lucide-react";
import { PdfThumb } from "@/components/preview/pdf-thumb";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { FileEntry } from "@/lib/types";

/** Non-text files (images, PDFs, fonts) open here instead of the editor, as in Overleaf. */
export function FileViewer({ resumeId, file }: { resumeId: string; file: FileEntry }) {
  const url = api.rawFileUrl(resumeId, file.path);
  const ext = file.path.split(".").pop()?.toLowerCase() ?? "";
  const image = ["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-xs text-muted-foreground">
        <span className="truncate font-mono text-foreground">{file.path}</span>
        <span className="tabular-nums">{file.size < 1024 ? `${file.size} B` : `${Math.round(file.size / 1024).toLocaleString()} KB`}</span>
        <Button size="xs" variant="ghost" className="ml-auto" nativeButton={false} render={<a href={url} download={file.path.split("/").pop()} />}>
          <Download />
          Download
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[var(--canvas)] p-6">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element -- a local file served by the API, not an optimisable asset
          <img
            src={url}
            alt={file.path}
            className="max-h-full max-w-full rounded bg-[repeating-conic-gradient(#2a2a2e_0%_25%,#1e1e22_0%_50%)] bg-[length:16px_16px] object-contain shadow-lg"
          />
        ) : ext === "pdf" ? (
          <div className="w-full max-w-md overflow-hidden rounded shadow-lg">
            <PdfThumb url={url} />
          </div>
        ) : (
          <div className="text-center text-sm text-muted-foreground">
            <FileQuestion className="mx-auto mb-2 size-8" />
            This file can&apos;t be shown here, but TeX can use it.
          </div>
        )}
      </div>
    </div>
  );
}
