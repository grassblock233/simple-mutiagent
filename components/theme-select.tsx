"use client";
import { useSyncExternalStore } from "react";
import { Icon } from "./studio-ui";
import { cx } from "./studio-styles";
type Theme = "system" | "light" | "dark";
const key = "simple-workflow-theme";
let transientTheme: Theme = "system";
function preference(): Theme {
  try {
    const value = localStorage.getItem(key);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return transientTheme;
  }
}
function apply() {
  const theme = preference();
  document.documentElement.dataset.theme =
    theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
}
function subscribe(callback: () => void) {
  const media = matchMedia("(prefers-color-scheme: dark)");
  const update = () => {
    apply();
    callback();
  };
  media.addEventListener("change", update);
  window.addEventListener("storage", update);
  window.addEventListener("workflow-theme", update);
  apply();
  return () => {
    media.removeEventListener("change", update);
    window.removeEventListener("storage", update);
    window.removeEventListener("workflow-theme", update);
  };
}
export function ThemeSelect() {
  const theme = useSyncExternalStore(
    subscribe,
    preference,
    () => "system" as Theme,
  );
  return (
    <div className={cx("theme-select")}>
      <Icon
        name={
          theme === "system" ? "monitor" : theme === "dark" ? "moon" : "sun"
        }
      />
      <select
        aria-label="界面主题"
        value={theme}
        onChange={(e) => {
          transientTheme = e.target.value as Theme;
          try {
            localStorage.setItem(key, transientTheme);
          } catch {
            /* Keep the selection for this session when storage is unavailable. */
          }
          window.dispatchEvent(new Event("workflow-theme"));
        }}
      >
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </div>
  );
}
function resolved(): "light" | "dark" {
  const theme = preference();
  return theme === "system"
    ? matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
    : theme;
}
export function useResolvedTheme() {
  return useSyncExternalStore(subscribe, resolved, () => "light" as const);
}
