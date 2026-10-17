"use client";
import type { Dispatch, SetStateAction } from "react";
import { cx } from "./studio-styles";
import type { RunState } from "@/lib/workflow/schema";
import { newestSnapshot } from "@/lib/workflow/snapshot";
import type { StudioActions } from "./studio-types";
type Setter<T> = Dispatch<SetStateAction<T>>;

type Props = StudioActions & {
  run?: RunState;
  setRun: Setter<RunState | undefined>;
};
export function ApprovalPanel({ run, setRun, busy, action, api }: Props) {
  const approval = run?.approvals.find((a) => a.status === "pending");
  return (
    <>
      {approval && (
        <section className={cx("approval-box")} aria-label="等待命令审核">
          <div>
            <strong>
              命令待审核 · 真实运行
            </strong>
            <code>
              {approval.executable} {JSON.stringify(approval.args)}
            </code>
            <p>
              节点 {approval.nodeId} · 第 {approval.round} 轮 · 版本{" "}
              {approval.version} · 目录 {approval.cwd}
            </p>
            <p>
              {approval.purpose} · 预计产物：{approval.artifacts.join(", ")}
            </p>
            <small>
              环境：{approval.environment}
              · 内容哈希：
              {approval.displayHash}
            </small>
          </div>
          <div className={cx("approval-actions")}>
            {(["rejected", "approved"] as const).map((decision) => (
              <button
                className={cx(decision === "approved" ? "primary" : "")}
                key={decision}
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    const snapshot = await api<RunState>(
                      `/api/runs/${run!.id}/approval`,
                      "POST",
                      {
                        id: approval.id,
                        displayHash: approval.displayHash,
                        decision,
                      },
                    );
                    setRun((current) => newestSnapshot(current, snapshot));
                  })
                }
              >
                {decision === "approved"
                  ? "批准本次命令"
                  : "拒绝"}
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
