"use client";

import { useDefaultLayout } from "react-resizable-panels";

// Panel sizes survive reloads (per browser). Storage access can throw (private mode): fall back to memory.
const memory = new Map<string, string>();
const storage = {
  getItem(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  },
  setItem(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      memory.set(key, value);
    }
  },
};

export function useLayout(id: string) {
  return useDefaultLayout({ id, storage });
}
