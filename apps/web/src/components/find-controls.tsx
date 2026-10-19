"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Pieces shared by the find bars (editor and PDF preview): key labels and the on/off option buttons.

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** "⌘" on macOS, "Ctrl+" elsewhere. */
export const MOD_KEY = mac ? "⌘" : "Ctrl+";
/** "⌥" on macOS, "Alt+" elsewhere. */
export const ALT_KEY = mac ? "⌥" : "Alt+";

/** An on/off search option (match case, whole word, regex), with its name and shortcut in a tooltip. */
export function FindToggle({
  label,
  keys,
  on,
  onClick,
  className,
  children,
}: {
  label: string;
  keys: string;
  on: boolean;
  onClick(): void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={on}
            // Keep the focus in the find field while clicking.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClick}
            className={cn(
              "flex shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5",
              on && "bg-primary/20 text-primary ring-1 ring-primary/50 hover:bg-primary/25 hover:text-primary",
              className ?? "size-5",
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        <span className="ml-1.5 text-muted-foreground">{keys}</span>
      </TooltipContent>
    </Tooltip>
  );
}
