export type StudioLayout = {
  leftWidth: number;
  rightWidth: number;
  resultHeight: number;
  leftOpen: boolean;
  rightOpen: boolean;
  expanded: boolean;
};

export const defaultLayout: StudioLayout = {
  leftWidth: 260,
  rightWidth: 300,
  resultHeight: 260,
  leftOpen: true,
  rightOpen: true,
  expanded: false,
};

export const layoutKey = "simple-workflow-layout-v1";
export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export function readLayout(raw: string | null): StudioLayout {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { ...defaultLayout };
    const result = { ...defaultLayout };
    for (const key of ["leftWidth", "rightWidth", "resultHeight"] as const) {
      const next = (value as Record<string, unknown>)[key];
      if (typeof next === "number" && Number.isFinite(next)) result[key] = next;
    }
    for (const key of ["leftOpen", "rightOpen", "expanded"] as const) {
      const next = (value as Record<string, unknown>)[key];
      if (typeof next === "boolean") result[key] = next;
    }
    return fitLayout(result, 1920, 1080);
  } catch {
    return { ...defaultLayout };
  }
}

// Keep at least 400px for the center, including when a saved layout is too wide.
// Fit the presentation without overwriting the user's larger-window preference.
export function fitLayout(
  layout: StudioLayout,
  width: number,
  height: number,
): StudioLayout {
  const sideBudget = Math.max(460, width - 48 - 10 - 400);
  const rightWidth = clamp(
    layout.rightWidth,
    240,
    Math.min(480, sideBudget - (layout.leftOpen ? 220 : 0)),
  );
  const leftWidth = clamp(
    layout.leftWidth,
    220,
    Math.min(420, sideBudget - (layout.rightOpen ? rightWidth : 0)),
  );
  return {
    ...layout,
    leftWidth,
    rightWidth,
    resultHeight: clamp(
      layout.resultHeight,
      140,
      Math.max(140, Math.floor((height - 70) * 0.45)),
    ),
  };
}
