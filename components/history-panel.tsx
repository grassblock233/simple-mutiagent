"use client";
import type { Dispatch, SetStateAction } from "react";
import { cx } from "./studio-styles";
import { Icon, EmptyState } from "./studio-ui";
import { statuses, applicationStatuses } from "@/lib/workflow/report";
import type { RunState } from "@/lib/workflow/schema";
import type { StudioActions, HistoryEntry } from "./studio-types";
type Setter<T> = Dispatch<SetStateAction<T>>;

type Props = StudioActions & {
  history: HistoryEntry[];
  setHistory: Setter<HistoryEntry[]>;
  acknowledgeDeletion: boolean;
  setAcknowledgeDeletion: Setter<boolean>;
  running: boolean;
  run?: RunState;
  setRun: Setter<RunState | undefined>;
  onView: () => void;
};
export function HistoryPanel({
  history,
  setHistory,
  acknowledgeDeletion,
  setAcknowledgeDeletion,
  running,
  run,
  setRun,
  onView,
  csrf,
  busy,
  action,
  api,
  setNotice,
}: Props) {
  return (
    <section className={cx("history-page")} aria-label="运行历史">
      <div className={cx("history-heading")}>
        <div>
          <h1>运行历史</h1>
        </div>
        <Icon name="history" />
      </div>
      <button
        disabled={busy || !csrf}
        onClick={() =>
          action(async () => {
            setHistory(
              (await api<{ runs: HistoryEntry[] }>("/api/history")).runs,
            );
          })
        }
      >
        刷新历史
      </button>
      <label className={cx("scope-row")}>
        <input
          type="checkbox"
          checked={acknowledgeDeletion}
          onChange={(e) => setAcknowledgeDeletion(e.target.checked)}
        />
        我理解删除历史会同时删除备份并失去撤销能力。
      </label>
      <div className={cx("history-list")}>
        {!history.length && (
          <EmptyState
            icon="history"
            title="还没有历史记录"
            description="点击刷新获取记录。"
          />
        )}
        {history.map((item) => (
          <div key={item.id}>
            <strong>{item.name}</strong>
            <small>
              {new Date(item.createdAt).toLocaleString("zh-CN")} ·{" "}
              {statuses[item.status]} ·{" "}
              {applicationStatuses[item.applicationStatus]}
            </small>
            <button
              disabled={busy || Boolean(running)}
              onClick={() =>
                action(async () => {
                  setRun(
                    await api<RunState>(`/api/history/${item.id}`, "POST", {}),
                  );
                  onView();
                })
              }
            >
              查看
            </button>
            <button
              disabled={busy || Boolean(running) || !acknowledgeDeletion}
              onClick={() =>
                action(async () => {
                  await api(`/api/history/${item.id}`, "DELETE", {
                    acknowledgeLossOfUndo: true,
                  });
                  setHistory((old) => old.filter((h) => h.id !== item.id));
                  if (run?.id === item.id) {
                    setRun(undefined);
                    try {
                      localStorage.removeItem("simple-workflow-last-run");
                    } catch {
                      /* Storage is optional. */
                    }
                  }
                  setNotice("历史及备份已删除。");
                })
              }
            >
              删除历史与备份
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
