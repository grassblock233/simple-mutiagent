"use client";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { outputPorts } from "@/lib/workflow/templates";
import { type NodeStatus, type WorkflowNode } from "@/lib/workflow/schema";

export type CanvasNode = Node<
  { node: WorkflowNode; status?: NodeStatus; invalid: boolean },
  "workflow"
>;
const icons = {
  read: "01",
  review: "02",
  repair: "03",
  rereview: "04",
  branch: "◇",
  loop: "↻",
  output: "✓",
};
const stateLabels = {
  running: "执行中",
  awaiting_approval: "等待审核",
  completed: "完成",
  failed: "失败",
  skipped: "跳过",
  cancelled: "取消",
};
export function WorkflowCard({ data, selected }: NodeProps<CanvasNode>) {
  const { node, status, invalid } = data;
  const ports = outputPorts(node);
  return (
    <div
      className={`workflow-card kind-${node.kind} ${selected ? "selected" : ""} ${invalid ? "invalid" : ""} status-${status ?? "idle"}`}
    >
      {node.kind !== "read" && (
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          aria-label="执行入口"
        />
      )}
      <div className="node-heading">
        <span className="node-icon">{icons[node.kind]}</span>
        <strong>{node.label}</strong>
      </div>
      <div className="node-description">
        {node.kind === "loop"
          ? `最多 ${node.config.maxRounds} 轮修复`
          : ["review", "repair", "rereview"].includes(node.kind)
            ? "DeepSeek Flash"
            : node.kind === "branch"
              ? "按顺序匹配 · 兜底出口"
              : node.kind === "read"
                ? "固定范围与代码版本"
                : "结论与应用状态"}
      </div>
      <div className="node-footer">
        <code>{node.id}</code>
        <span>{status ? stateLabels[status] : "待运行"}</span>
      </div>
      {ports.map((port, i) => (
        <div key={port}>
          <Handle
            type="source"
            position={Position.Right}
            id={port}
            style={{ top: `${((i + 1) * 100) / (ports.length + 1)}%` }}
            aria-label={`出口 ${port}`}
          />
          {ports.length > 1 && (
            <span
              className="port-label"
              style={{ top: `${((i + 1) * 100) / (ports.length + 1)}%` }}
            >
              {port}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
