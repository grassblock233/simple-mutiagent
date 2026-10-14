"use client";
import { useEffect, useRef, type RefObject } from "react";
export function useDrawerFocus(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  query: string,
  close: () => void,
) {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const media = matchMedia(query);
    let cleanup: (() => void) | undefined;
    function activate() {
      cleanup?.();
      cleanup = undefined;
      const panel = ref.current;
      if (!media.matches || !panel) return;
      const trigger = document.activeElement as HTMLElement | null;
      const focusable = () =>
        Array.from(
          panel!.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex="0"]',
          ),
        ).filter((el) => el.getClientRects().length > 0);
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      focusable()[0]?.focus();
      function keydown(event: KeyboardEvent) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeRef.current();
        }
        if (event.key === "Tab") {
          const items = focusable(),
            first = items[0],
            last = items.at(-1);
          if (
            event.shiftKey &&
            (document.activeElement === first ||
              !panel!.contains(document.activeElement))
          ) {
            event.preventDefault();
            last?.focus();
          } else if (
            !event.shiftKey &&
            (document.activeElement === last ||
              !panel!.contains(document.activeElement))
          ) {
            event.preventDefault();
            first?.focus();
          }
        }
      }
      document.addEventListener("keydown", keydown);
      cleanup = () => {
        document.removeEventListener("keydown", keydown);
        panel.removeAttribute("role");
        panel.removeAttribute("aria-modal");
        if (
          (panel.contains(document.activeElement) ||
            document.activeElement === document.body ||
            document.activeElement?.hasAttribute("data-dialog-backdrop")) &&
          trigger?.isConnected &&
          trigger.getClientRects().length
        )
          trigger.focus();
      };
    }
    activate();
    media.addEventListener("change", activate);
    return () => {
      media.removeEventListener("change", activate);
      cleanup?.();
    };
  }, [open, query, ref]);
}
