"use client";

import { useEffect } from "react";

// Mirrors your preferences (every "rs.*" key in this browser's storage: editor settings, autosave, preview
// zoom, pane sizes) to the app's preferences file, so they're backed up and restored with your data.
//
// Whose copy wins: the file records when it last changed. MARK remembers which version of the file this
// browser last matched. If the file changed since (another browser, or a restore), the file's values are
// applied here and the page reloads once so everything picks them up. Otherwise this browser's values are
// the newest, and they're written to the file whenever they change.

const PREFIX = "rs.";
const MARK = "rs~prefs-revision"; // not "rs.": never mirrored itself
const INTERVAL_MS = 4000;

type Prefs = { updatedAt: string | null; values: Record<string, string> };

function local(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(PREFIX)) out[k] = localStorage.getItem(k) ?? "";
  }
  return out;
}

const same = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

export function PreferencesMirror() {
  useEffect(() => {
    let stopped = false;
    let pushed: Record<string, string> | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const push = async (values: Record<string, string>, keepalive = false) => {
      pushed = values;
      try {
        const res = await fetch("/api/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }), keepalive });
        if (res.ok) localStorage.setItem(MARK, ((await res.json()) as Prefs).updatedAt ?? "");
      } catch {
        pushed = null; // try again next time
      }
    };
    const flush = (keepalive = false) => {
      try {
        const now = local();
        if (!pushed || !same(now, pushed)) void push(now, keepalive);
      } catch {
        // Storage unavailable (private mode): nothing to mirror.
      }
    };

    void (async () => {
      let server: Prefs;
      try {
        localStorage.getItem(MARK); // throws where storage is unavailable
        server = (await (await fetch("/api/preferences", { cache: "no-store" })).json()) as Prefs;
      } catch {
        return;
      }
      if (stopped) return;
      const here = local();
      if (server.updatedAt && server.updatedAt !== localStorage.getItem(MARK)) {
        // The file is newer than what this browser last saw: apply it.
        const differs = Object.entries(server.values).some(([k, v]) => here[k] !== v);
        for (const [k, v] of Object.entries(server.values)) localStorage.setItem(k, v);
        localStorage.setItem(MARK, server.updatedAt);
        if (differs) {
          window.location.reload();
          return;
        }
        pushed = server.values;
      } else {
        pushed = server.values;
      }
      flush();
      timer = setInterval(() => flush(), INTERVAL_MS);
    })();

    const onHide = () => document.visibilityState === "hidden" && flush(true);
    const onLeave = () => flush(true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onLeave);
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onLeave);
    };
  }, []);
  return null;
}
