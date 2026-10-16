"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ServerEvent } from "./types";

// One EventSource per tab, shared by every component that listens. EventSource reconnects on its own;
// `connected` lets the UI say when the app server is unreachable.

type Fn = (e: ServerEvent) => void;
const listeners = new Set<Fn>();
const statusListeners = new Set<() => void>();
let source: EventSource | null = null;
let connected = true;
let reconnectHandlers = new Set<() => void>();

function setConnected(v: boolean) {
  if (connected === v) return;
  connected = v;
  statusListeners.forEach((f) => f());
  if (v) reconnectHandlers.forEach((f) => f());
}

function ensure() {
  if (source || typeof window === "undefined") return;
  source = new EventSource("/api/events");
  source.onopen = () => setConnected(true);
  source.onerror = () => setConnected(source?.readyState === EventSource.OPEN);
  source.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data) as ServerEvent;
      listeners.forEach((f) => f(e));
    } catch {
      // Ignore malformed events.
    }
  };
}

/** Calls `fn` for every server event. `onReconnect` runs after the stream comes back (to refetch state). */
export function useServerEvents(fn: Fn, onReconnect?: () => void) {
  const ref = useRef(fn);
  const reRef = useRef(onReconnect);
  useEffect(() => {
    ref.current = fn;
    reRef.current = onReconnect;
  });
  useEffect(() => {
    ensure();
    const l: Fn = (e) => ref.current(e);
    const r = () => reRef.current?.();
    listeners.add(l);
    reconnectHandlers.add(r);
    return () => {
      listeners.delete(l);
      reconnectHandlers.delete(r);
    };
  }, []);
}

export function useConnected(): boolean {
  return useSyncExternalStore(
    (cb) => {
      ensure();
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    () => connected,
    () => true,
  );
}

// Exported for tests/hot reload hygiene.
export function _resetEvents() {
  source?.close();
  source = null;
  reconnectHandlers = new Set();
}
