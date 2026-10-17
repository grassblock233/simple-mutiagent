"use client";
import type { Dispatch, SetStateAction } from "react";
import { cx } from "./studio-styles";
import { Icon, EmptyState, handleTabKeys, nodeStatusLabels } from "./studio-ui";
import {
  statuses,
  applicationStatuses,
  conclusions,
} from "@/lib/workflow/report";
import type { RunState } from "@/lib/workflow/schema";
import { newestSnapshot } from "@/lib/workflow/snapshot";
import type { StudioActions } from "./studio-types";
type Setter<T> = Dispatch<SetStateAction<T>>;

type Props = StudioActions & {
  run?: RunState;
  setRun: Setter<RunState | undefined>;
  running: boolean;
  selectedId: string;
  view: "events" | "results" | "diff";
  setView: Setter<"events" | "results" | "diff">;
  expanded: boolean;
  setExpanded: Setter<boolean>;
  onSettings: () => void;
};
export function ExecutionPanel({
  run,
  setRun,
  running,
  selectedId,
  view,
  setView,
  expanded,
  setExpanded,
  onSettings,
  busy,
  action,
  api,
}: Props) {
  const nodeRecords = run?.records.filter((r) => r.nodeId === selectedId) ?? [];
  const changes =
    run?.records.flatMap((r) =>
      r.output?.type === "repair"
        ? r.output.changes.map((c) => ({ ...c, round: r.round }))
        : [],
    ) ?? [];
  return (
    <section
      className={cx(`execution ${expanded ? "expanded" : "collapsed"}`)}
      aria-label="执行结果"
    >
      <div className={cx("execution-toolbar")}>
        <button
          className={cx("icon-button")}
          aria-label={expanded ? "收起执行结果" : "展开执行结果"}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <Icon name={expanded ? "chevron-down" : "chevron-up"} />
        </button>
        <div
          className={cx("result-tabs")}
          role="tablist"
          onKeyDown={handleTabKeys}
          aria-label="执行结果"
        >
          {(["events", "results", "diff"] as const).map((tab) => (
            <button
              className={cx(view === tab ? "active" : "")}
              key={tab}
              role="tab"
              aria-selected={view === tab}
              onClick={() => {
                setView(tab);
                setExpanded(true);
              }}
            >
              {tab === "events"
                ? "执行记录"
                : tab === "results"
                  ? "节点输入 / 输出"
                  : "最终差异 / 各轮"}
            </button>
          ))}
        </div>
        <span className={cx("run-state")}>
          {run
            ? `${statuses[run.status]} · 修复 ${run.round}/${run.maxRounds} 轮`
            : "尚未运行"}
        </span>
        <div className={cx("toolbar-buttons execution-actions")}>
          {run && (
            <>
              <button
                disabled={!running || busy}
                onClick={() =>
                  action(async () => {
                    const snapshot = await api<RunState>(
                      `/api/runs/${run.id}/cancel`,
                      "POST",
                      {},
                    );
                    setRun((current) => newestSnapshot(current, snapshot));
                  })
                }
              >
                取消运行
              </button>
              <button
                disabled={Boolean(running) || busy}
                onClick={() =>
                  action(async () => {
                    setRun(
                      await api<RunState>(`/api/runs/${run.id}/retry`, "POST", {
                        requestId: crypto.randomUUID(),
                      }),
                    );
                    setExpanded(true);
                  })
                }
              >
                重新运行
              </button>
              {run.changes?.length ? (
                <button
                  disabled={
                    Boolean(running) ||
                    busy ||
                    !["passed", "issues_remaining"].includes(
                      run.reviewConclusion ?? run.conclusion ?? "",
                    ) ||
                    ["applied", "undone"].includes(run.applicationStatus)
                  }
                  onClick={() =>
                    action(async () => {
                      setRun(
                        await api<RunState>(
                          `/api/runs/${run.id}/apply`,
                          "POST",
                          {
                            version: run.currentVersion,
                          },
                        ),
                      );
                    })
                  }
                >
                  确认应用最终差异
                </button>
              ) : null}
              {run.applicationStatus === "applied" && (
                <button
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      setRun(
                        await api<RunState>(
                          `/api/runs/${run.id}/undo`,
                          "POST",
                          {},
                        ),
                      );
                    })
                  }
                >
                  撤销本次应用
                </button>
              )}
              <a
                className={cx("button-link")}
                href={`/api/runs/${run.id}/report`}
              >
                Markdown
              </a>
              <a
                className={cx("button-link")}
                href={`/api/runs/${run.id}/report?format=json`}
              >
                JSON
              </a>
            </>
          )}
        </div>
      </div>
      <div hidden={!expanded} className={cx("execution-content")}>
        {run?.conclusion && (
          <div className={cx(`conclusion conclusion-${run.conclusion}`)}>
            <strong>
              {conclusions[run.conclusion]} ·{" "}
              真实运行
            </strong>
            <span>{run.exitReason}</span>
            <span>
              文件：{applicationStatuses[run.applicationStatus]}
              {run.applicationError ? ` · ${run.applicationError}` : ""}
            </span>
          </div>
        )}
        <div className={cx("execution-body")} role="tabpanel">
          {!run ? (
            <EmptyState
              icon="play"
              title="尚未运行"
              description="在运行设置中启动工作流。"
              action={
                <button className={cx("primary")} onClick={onSettings}>
                  <Icon name="play" />
                  设置运行
                </button>
              }
            />
          ) : view === "events" ? (
            <div className={cx("event-list")}>
              {!run.events.length && (
                <EmptyState
                  icon="activity"
                  title="等待执行事件"
                  description=""
                  compact
                />
              )}
              {run.events.map((event) => (
                <div key={event.seq}>
                  <span className={cx("event-seq")}>
                    {String(event.seq).padStart(2, "0")}
                  </span>
                  <time>
                    {new Date(event.time).toLocaleTimeString("zh-CN", {
                      hour12: false,
                    })}
                  </time>
                  <code>{event.nodeId ?? "workflow"}</code>
                  <span>{event.message}</span>
                </div>
              ))}
            </div>
          ) : view === "results" ? (
            <div className={cx("node-records")}>
              {nodeRecords.length ? (
                nodeRecords.map((record) => (
                  <details key={record.id} open>
                    <summary>
                      {record.nodeId} · 第 {record.round} 轮 ·{" "}
                      {nodeStatusLabels[record.status]} · 输入版本{" "}
                      {record.inputVersion}
                    </summary>
                    <pre>
                      {JSON.stringify(
                        {
                          input: record.input,
                          output: record.output,
                          error: record.error,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                ))
              ) : (
                <p className={cx("help")}>选中节点尚无执行记录。</p>
              )}
            </div>
          ) : (
            <div className={cx("diff-list")}>
              <details open>
                <summary>最终整批差异 · {run.currentVersion}</summary>
                <pre>{JSON.stringify(run.changes ?? [], null, 2)}</pre>
              </details>
              {changes.length ? (
                changes.map((change, i) => (
                  <div key={i}>
                    <strong>
                      {change.path} · 第 {change.round} 轮 ·{" "}
                      副本差异
                    </strong>
                    <pre className={cx("diff-before")}>
                      − {change.before ?? "（原先不存在）"}
                    </pre>
                    <pre className={cx("diff-after")}>
                      + {change.after ?? "（删除）"}
                    </pre>
                  </div>
                ))
              ) : (
                <p className={cx("help")}>尚无修复差异。</p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
