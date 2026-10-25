"use client";
import { useEffect } from "react";
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  isDefaultBlockingBranch,
  outputPortLabel,
  outputPorts,
} from "@/lib/workflow/templates";
import { type NodeStatus, type WorkflowNode } from "@/lib/workflow/schema";
import { Icon, nodeIcons, nodeStatusLabels } from "./studio-ui";
import { cx } from "./studio-styles";
export type CanvasNode = Node<
  { node: WorkflowNode; status?: NodeStatus; invalid: boolean },
  "workflow"
>;
export function WorkflowCard({ data, selected }: NodeProps<CanvasNode>) {
  const { node, status, invalid } = data;
  const ports = outputPorts(node);
  // Keep the direct path above the repair path on the canvas.
  if (isDefaultBlockingBranch(node)) ports.reverse();
  const updateNodeInternals = useUpdateNodeInternals();
  const portOrder = ports.join("\0");
  useEffect(() => {
    updateNodeInternals(node.id);
  }, [node.id, portOrder, updateNodeInternals]);
  return (
    <div
      className={cx(
        `workflow-card kind-${node.kind} ${selected ? "selected" : ""} ${invalid ? "invalid" : ""} status-${status ?? "idle"}`,
      )}
    >
      {node.kind !== "read" && (
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          aria-label="执行入口"
        />
      )}
      <div className={cx("node-heading")}>
        <span className={cx("node-icon")}>
          <Icon name={nodeIcons[node.kind]} />
        </span>
        <div>
          <span className={cx("node-kind")}>{node.kind.toUpperCase()}</span>
          <strong style={{ display: "block" }}>{node.label}</strong>
        </div>
      </div>
      {node.kind === "loop" && (
        <div className={cx("node-description")}>
          最多 {node.config.maxRounds} 轮修复
        </div>
      )}
      {ports.length > 1 ? (
        <div className={cx("node-ports")}>
          {ports.map((port) => (
            <div key={port} className={cx("port-row")}>
              <span className={cx("port-label")}>
                {outputPortLabel(node, port)}
              </span>
              <Handle
                type="source"
                position={Position.Right}
                id={port}
                aria-label={`出口 ${outputPortLabel(node, port)}`}
              />
            </div>
          ))}
        </div>
      ) : (
        ports.map((port) => (
          <Handle
            key={port}
            type="source"
            position={Position.Right}
            id={port}
            aria-label={`出口 ${outputPortLabel(node, port)}`}
          />
        ))
      )}
      <div className={cx("node-footer")}>
        <code title={node.id}>{node.id}</code>
        <span className={cx("node-state")}>
          <i className={cx("status-dot")} />
          {invalid
            ? "配置待修正"
            : status
              ? nodeStatusLabels[status]
              : "待运行"}
        </span>
      </div>
    </div>
  );
}
