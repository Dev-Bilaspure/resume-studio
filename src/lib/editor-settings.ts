"use client";

import { useSyncExternalStore } from "react";

// Editor preferences (Overleaf's Settings → Editor), per browser.

export type KeymapMode = "default" | "vim" | "emacs";

export interface EditorSettings {
  fontSize: number;
  keymap: KeymapMode;
  lineWrapping: boolean;
  spellcheck: boolean;
  autocomplete: boolean;
  /** Close \begin{…} with \end{…} and pair braces. */
  autoClose: boolean;
}

export const DEFAULT_SETTINGS: EditorSettings = { fontSize: 13, keymap: "default", lineWrapping: true, spellcheck: false, autocomplete: true, autoClose: true };

const KEY = "rs.editor";
const listeners = new Set<() => void>();
let cache: EditorSettings | null = null;

function read(): EditorSettings {
  if (cache) return cache;
  try {
    cache = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    cache = DEFAULT_SETTINGS;
  }
  return cache!;
}

export function setEditorSettings(patch: Partial<EditorSettings>) {
  cache = { ...read(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Kept for this page view only.
  }
  listeners.forEach((f) => f());
}

export function useEditorSettings(): EditorSettings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => DEFAULT_SETTINGS,
  );
}
