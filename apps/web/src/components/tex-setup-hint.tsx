import type { SystemStatus } from "@/lib/types";

const Cmd = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{children}</code>
);

/** Why nothing can compile, and the one thing to do about it. */
export function TexSetupHint({ system }: { system: SystemStatus }) {
  if (system.compiler.mode === "service") {
    return (
      <>
        The compile service isn&apos;t running{system.compiler.url ? ` (${system.compiler.url})` : ""}. Start it from the repository folder:{" "}
        <Cmd>docker compose up -d</Cmd>. The first start downloads TeX Live (a few GB); after that it starts in seconds.
      </>
    );
  }
  return (
    <>
      TeX isn&apos;t installed, so nothing can compile. Either run the compile service (<Cmd>docker compose up -d</Cmd>, no other setup), or install MacTeX (
      <Cmd>brew install --cask mactex-no-gui</Cmd>, the full TeX Live, the same as Overleaf).
    </>
  );
}
