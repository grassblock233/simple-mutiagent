"use client";
import { useSyncExternalStore, type SetStateAction } from "react";
import {
  defaultLayout,
  fitLayout,
  layoutKey,
  readLayout,
  type StudioLayout,
} from "@/lib/studio/layout";

let current = defaultLayout;
const listeners = new Set<() => void>();
let initialized = false;
function snapshot() {
  return current;
}
function subscribe(callback: () => void) {
  if (!initialized) {
    initialized = true;
    try {
      current = readLayout(localStorage.getItem(layoutKey));
    } catch {
      current = { ...defaultLayout };
    }
  }
  listeners.add(callback);
  const onStorage = (event: StorageEvent) => {
    if (event.key === layoutKey || event.key === null) {
      try {
        current = readLayout(localStorage.getItem(layoutKey));
      } catch {
        current = { ...defaultLayout };
      }
      listeners.forEach((listener) => listener());
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", onStorage);
  };
}
function setLayout(value: SetStateAction<StudioLayout>) {
  current = typeof value === "function" ? value(current) : value;
  try {
    localStorage.setItem(layoutKey, JSON.stringify(current));
  } catch {
    /* Session-only when storage is unavailable. */
  }
  listeners.forEach((listener) => listener());
}
function subscribeViewport(callback: () => void) {
  window.addEventListener("resize", callback);
  return () => window.removeEventListener("resize", callback);
}
function viewport() {
  return `${window.innerWidth},${window.innerHeight}`;
}
export function useStudioLayout() {
  const stored = useSyncExternalStore(subscribe, snapshot, () => defaultLayout);
  const [width, height] = useSyncExternalStore(
    subscribeViewport,
    viewport,
    () => "1440,900",
  )
    .split(",")
    .map(Number);
  return { layout: fitLayout(stored, width, height), setLayout, width, height };
}
