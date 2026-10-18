"use client";

import { ChevronDown, FileArchive, Hash, Loader2, MoreHorizontal, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { ResumeMeta, WordCount } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Recompile, plus Overleaf's compile options: auto compile, stop on first error, clear cached files. */
export function RecompileButton(props: {
  running: boolean;
  meta: ResumeMeta;
  autosave: boolean;
  onAutosave(on: boolean): void;
  onCompile(): void;
  onClean(): void;
  onChanged(meta: ResumeMeta): void;
  shortcut: React.ReactNode;
}) {
  const setHalt = async (on: boolean) => {
    try {
      props.onChanged(await api.update(props.meta.id, { haltOnError: on }));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="flex items-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label="Recompile" className="rounded-r-none" onClick={props.onCompile} disabled={props.running} />
          }
        >
          <RefreshCw className={cn(props.running && "animate-spin")} />
        </TooltipTrigger>
        <TooltipContent>Recompile {props.shortcut}</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Compile options" className="w-5 rounded-l-none" />}>
          <ChevronDown className="size-3!" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Compile options</DropdownMenuLabel>
            <DropdownMenuCheckboxItem checked={props.autosave} onCheckedChange={(v) => props.onAutosave(!!v)}>
              Auto compile
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={props.meta.haltOnError} onCheckedChange={(v) => void setHalt(!!v)}>
              Stop on first error
            </DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={props.onClean}>
            <Trash2 />
            Clear cached files and recompile
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Project actions: download the source as .zip (re-uploadable to Overleaf), word count. */
export function ProjectMenu({ resumeId }: { resumeId: string }) {
  const [count, setCount] = useState<WordCount | null>(null);
  const [counting, setCounting] = useState(false);

  const wordCount = async () => {
    setCounting(true);
    try {
      setCount(await api.wordCount(resumeId));
    } catch (e) {
      toast.error("Couldn't count words", { description: (e as Error).message });
    } finally {
      setCounting(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Project menu" title="Project menu" />}>
          {counting ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem render={<a href={api.zipUrl(resumeId)} download />}>
            <FileArchive />
            Download source (.zip)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void wordCount()}>
            <Hash />
            Word count
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={!!count} onOpenChange={(o) => !o && setCount(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Word count</DialogTitle>
            <DialogDescription>Counted by texcount across the main file and everything it includes.</DialogDescription>
          </DialogHeader>
          {count && (
            <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 text-sm tabular-nums">
              <dt className="text-muted-foreground">Words in text</dt>
              <dd className="text-right font-medium">{count.text.toLocaleString()}</dd>
              <dt className="text-muted-foreground">Words in headings</dt>
              <dd className="text-right">{count.headers.toLocaleString()}</dd>
              <dt className="text-muted-foreground">Words in captions etc.</dt>
              <dd className="text-right">{count.captions.toLocaleString()}</dd>
              <dt className="border-t pt-1.5 font-medium">Total</dt>
              <dd className="border-t pt-1.5 text-right font-medium">{count.words.toLocaleString()}</dd>
            </dl>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
