import type { RunState } from "@/lib/workflow/schema";
export type Workspace = {
  id: string;
  root: string;
  files: string[];
  excludes: string[];
};
export type ScopeSelection = { path: string; directory: boolean };
export type HistoryEntry = {
  id: string;
  name: string;
  createdAt: string;
  status: RunState["status"];
  applicationStatus: RunState["applicationStatus"];
};
export type StudioActions = {
  csrf: string;
  busy: boolean;
  action: (work: () => Promise<void>) => Promise<void>;
  api: <T = unknown>(
    url: string,
    method?: string,
    value?: unknown,
  ) => Promise<T>;
  setNotice: (notice: string) => void;
};
