import Link from "next/link";

/** The top bar of the tailoring pages: app name, a breadcrumb and actions on the right. */
export function TailorHeader({ crumbs, children }: { crumbs: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur-md">
      <Link href="/" className="flex items-center gap-2 pr-1 text-sm font-semibold tracking-tight" title="All resumes">
        <span className="size-2.5 rounded-[3px] bg-primary" aria-hidden />
        <span className="hidden sm:inline">Resume Studio</span>
      </Link>
      <span className="text-muted-foreground/50">/</span>
      <div className="flex min-w-0 items-center gap-2 text-sm">{crumbs}</div>
      <div className="ml-auto flex items-center gap-1.5">{children}</div>
    </header>
  );
}
