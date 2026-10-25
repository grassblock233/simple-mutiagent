export type StudioLayout = { leftWidth: number; rightWidth: number; resultHeight: number; leftOpen: boolean; rightOpen: boolean; expanded: boolean; activeSide?: "left" | "right" };
export const defaultLayout: StudioLayout = { leftWidth: 260, rightWidth: 300, resultHeight: 260, leftOpen: true, rightOpen: true, expanded: false };
export const layoutKey = "simple-workflow-layout-v1";
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function readLayout(raw: string | null): StudioLayout {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ...defaultLayout };
    const result = { ...defaultLayout };
    for (const key of ["leftWidth", "rightWidth", "resultHeight"] as const) if (typeof value[key] === "number" && Number.isFinite(value[key])) result[key] = value[key];
    for (const key of ["leftOpen", "rightOpen", "expanded"] as const) if (typeof value[key] === "boolean") result[key] = value[key];
    if (["left", "right"].includes(value.activeSide)) result.activeSide = value.activeSide;
    result.leftWidth = clamp(result.leftWidth, 220, 420); result.rightWidth = clamp(result.rightWidth, 240, 480); result.resultHeight = Math.max(140, result.resultHeight);
    return result;
  } catch { return { ...defaultLayout }; }
}
export function fitLayout(layout: StudioLayout, width: number, height: number): StudioLayout {
  let { leftOpen, rightOpen } = layout;
  const sideBudget = Math.max(0, width - 48 - 10 - 400);
  if (leftOpen && rightOpen && sideBudget < 460) {
    if (layout.activeSide === "left") rightOpen = false; else leftOpen = false;
  }
  return { ...layout, leftOpen, rightOpen,
    rightWidth: clamp(layout.rightWidth, 240, Math.min(480, sideBudget - (leftOpen ? 220 : 0))),
    leftWidth: clamp(layout.leftWidth, 220, Math.min(420, sideBudget - (rightOpen ? clamp(layout.rightWidth, 240, Math.min(480, sideBudget - (leftOpen ? 220 : 0))) : 0))),
    resultHeight: clamp(layout.resultHeight, 140, Math.max(140, Math.floor((height - 70) * 0.45))),
  };
}
