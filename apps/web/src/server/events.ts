import "server-only";
import { EventEmitter } from "node:events";
import type { ServerEvent } from "@/lib/types";

// One bus per server process (kept on globalThis so dev-mode module reloads share it).
const g = globalThis as unknown as { __rsBus?: EventEmitter };
const bus = (g.__rsBus ??= Object.assign(new EventEmitter(), {}));
bus.setMaxListeners(100);

export function emit(event: ServerEvent) {
  bus.emit("event", event);
}

export function subscribe(fn: (e: ServerEvent) => void): () => void {
  bus.on("event", fn);
  return () => bus.off("event", fn);
}
