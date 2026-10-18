import type { KeyboardEvent, ReactNode } from "react";
import type { NodeKind } from "@/lib/workflow/schema";
import { cx } from "./studio-styles";
const paths = {
  home: "M3 10 12 3l9 7 M5 9v12h14V9 M9 21v-8h6v8",
  "chevron-right": "m9 6 6 6-6 6",
  "arrow-right": "M4 12h16 M14 6l6 6-6 6",
  "panel-right": "M3 4h18v16H3z M15 4v16",
  workflow: "M5 4h5v5H5z M14 15h5v5h-5z M14 4h5v5h-5z M7.5 9v8.5H14 M10 6.5h4",
  folder: "M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z",
  layers: "m12 3 9 5-9 5-9-5z M3 12l9 5 9-5 M3 16l9 5 9-5",
  history: "M3 11a9 9 0 1 1 2.5 7 M3 4v7h7 M12 7v5l3 2",
  play: "m8 5 11 7-11 7z",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6",
  sidebar: "M3 4h18v16H3z M9 4v16",
  sliders: "M4 7h9 M17 7h3 M4 17h3 M11 17h9 M13 4v6 M7 14v6",
  close: "m6 6 12 12 M18 6 6 18",
  back: "m14 5-7 7 7 7 M7 12h14",
  "chevron-down": "m6 9 6 6 6-6",
  "chevron-up": "m6 15 6-6 6 6",
  check: "m5 12 4 4L19 6",
  alert: "m12 3 10 18H2z M12 9v5 M12 17h.01",
  activity: "M2 12h5l3-8 4 16 3-8h5",
  file: "M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 17h6",
  search: "M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0z M14.5 14.5 21 21",
  tool: "m14 6 4-4a6 6 0 0 1-7 8L4 17a2 2 0 0 0 3 3l7-7a6 6 0 0 0 8-7l-4 4z",
  branch:
    "M7 3v12a4 4 0 0 0 4 4h6 M7 10a8 8 0 0 0 10-7 M4 3h6 M14 3h6 M14 16l3 3-3 3",
  loop: "M20 7a8 8 0 0 0-14-2L3 8 M3 3v5h5 M4 17a8 8 0 0 0 14 2l3-3 M21 21v-5h-5",
  sun: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5 19 19 M5 19l1.5-1.5 M17.5 6.5 19 5",
  moon: "M20 14a9 9 0 0 1-10-11 9 9 0 1 0 10 11z",
  monitor: "M3 4h18v13H3z M12 17v4 M8 21h8",
  plus: "M12 5v14 M5 12h14",
} as const;
export type IconName = keyof typeof paths;
export const nodeIcons: Record<NodeKind, IconName> = {
  read: "file",
  review: "search",
  repair: "tool",
  rereview: "shield",
  branch: "branch",
  loop: "loop",
  output: "check",
};
export function Icon({
  name,
  className,
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon: IconName;
  title: string;
  description: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cx(`empty-state ${compact ? "compact" : ""}`)}>
      <span className={cx("empty-icon")}>
        <Icon name={icon} />
      </span>
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

export function handleTabKeys(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  );
  const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
          tabs.length;
  tabs[next]?.focus();
  tabs[next]?.click();
}
export const nodeStatusLabels = {
  running: "执行中",
  awaiting_approval: "等待审核",
  completed: "完成",
  failed: "失败",
  skipped: "跳过",
  cancelled: "取消",
};
