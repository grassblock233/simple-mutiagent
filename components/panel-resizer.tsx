"use client";
import { useRef } from "react";
import { clamp } from "@/lib/studio/layout";
import { cx } from "./studio-styles";

export function PanelResizer({
  label,
  horizontal = false,
  reverse = false,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  horizontal?: boolean;
  reverse?: boolean;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const drag = useRef<{ position: number; value: number } | null>(null);
  return (
    <div
      className={cx(`panel-resizer ${horizontal ? "horizontal" : "vertical"}`)}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          position: horizontal ? event.clientY : event.clientX,
          value,
        };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const delta =
          ((horizontal ? event.clientY : event.clientX) -
            drag.current.position) *
          (reverse ? -1 : 1);
        onChange(clamp(drag.current.value + delta, min, max));
      }}
      onPointerUp={(event) => {
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        const decrease = horizontal ? "ArrowUp" : "ArrowLeft";
        const increase = horizontal ? "ArrowDown" : "ArrowRight";
        if (![decrease, increase, "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        onChange(
          event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : clamp(
                  value +
                    (event.key === increase ? 1 : -1) *
                      (reverse ? -1 : 1) *
                      (event.shiftKey ? 40 : 10),
                  min,
                  max,
                ),
        );
      }}
    />
  );
}
