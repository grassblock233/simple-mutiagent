"use client";
import { useState } from "react";
import { cx } from "./studio-styles";
import { labels, nodeSchema, type WorkflowNode } from "@/lib/workflow/schema";

export function NodeConfig({
  node,
  update,
  remove,
}: {
  node: WorkflowNode;
  update: (node: WorkflowNode) => void;
  remove: () => void;
}) {
  const [advanced, setAdvanced] = useState("");
  const [error, setError] = useState("");
  return (
    <>
      <div className={cx("config-node")}>
        <span className={cx("eyebrow")}>{node.kind.toUpperCase()}</span>
        <h3>{labels[node.kind]}</h3>
        <code>{node.id}</code>
      </div>
      <label>
        显示名称
        <input
          value={node.label}
          onChange={(e) => update({ ...node, label: e.target.value })}
        />
      </label>
      {(node.kind === "review" ||
        node.kind === "repair" ||
        node.kind === "rereview") && (
        <>
          <label>
            模型
            <select value={node.config.model} disabled>
              <option>deepseek-flash</option>
            </select>
          </label>
          <label>
            节点提示词
            <textarea
              rows={5}
              value={node.config.prompt}
              onChange={(e) =>
                update({
                  ...node,
                  config: { ...node.config, prompt: e.target.value },
                })
              }
            />
          </label>
          <label className={cx("checkbox-label")}>
            <input
              type="checkbox"
              checked={node.config.thinking}
              onChange={(e) =>
                update({
                  ...node,
                  config: { ...node.config, thinking: e.target.checked },
                })
              }
            />
            启用思考
          </label>
          <label>
            思考强度
            <select
              disabled={!node.config.thinking}
              value={node.config.reasoningEffort}
              onChange={(e) =>
                update({
                  ...node,
                  config: {
                    ...node.config,
                    reasoningEffort: e.target.value as "low" | "high" | "max",
                  },
                })
              }
            >
              <option>low</option>
              <option>high</option>
              <option>max</option>
            </select>
          </label>
          <label>
            输出预算
            <input
              type="number"
              min={256}
              max={16384}
              value={node.config.maxOutputTokens}
              onChange={(e) =>
                update({
                  ...node,
                  config: {
                    ...node.config,
                    maxOutputTokens: Number(e.target.value),
                  },
                })
              }
            />
          </label>
          <label className={cx("checkbox-label")}>
            <input
              type="checkbox"
              checked={node.config.requireValidation}
              onChange={(e) =>
                update({
                  ...node,
                  config: {
                    ...node.config,
                    requireValidation: e.target.checked,
                  },
                })
              }
            />
            必须完成验证
          </label>
        </>
      )}
      {node.kind === "loop" && (
        <>
          <label>
            修复轮数上限
            <input
              type="number"
              min={1}
              max={5}
              value={node.config.maxRounds}
              onChange={(e) =>
                update({
                  ...node,
                  config: { ...node.config, maxRounds: Number(e.target.value) },
                })
              }
            />
          </label>
          <label>
            循环入口
            <input
              value={node.config.entryNodeId}
              onChange={(e) =>
                update({
                  ...node,
                  config: { ...node.config, entryNodeId: e.target.value },
                })
              }
            />
          </label>
        </>
      )}
      {node.kind === "branch" && (
        <>
          <h3>有序条件</h3>
          {node.config.conditions.map((condition, i) => (
            <div className={cx("condition-editor")} key={condition.id}>
              <strong>
                {i + 1}. {condition.id}
              </strong>
              <code>
                {condition.field} {condition.operator === "gt" ? ">" : "="}{" "}
                {String(condition.value)}
              </code>
            </div>
          ))}
          <p className={cx("help")}>
            通过 JSON 编辑条件
          </p>
        </>
      )}
      {Object.entries(node.inputs).map(([slot, ref]) => (
        <label key={slot}>
          输入 {slot} 的来源
          <input
            value={ref.sources.join(", ")}
            onChange={(e) =>
              update({
                ...node,
                inputs: {
                  ...node.inputs,
                  [slot]: {
                    ...ref,
                    sources: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  },
                },
              } as WorkflowNode)
            }
          />
          <small>
            {ref.output} ·{" "}
            {ref.freshness === "baseline" ? "基线版本" : "当前版本与轮次"} ·
            来源用逗号分隔
          </small>
        </label>
      ))}
      <details
        className={cx("advanced-config")}
        onToggle={(e) => {
          if (e.currentTarget.open)
            setAdvanced(
              JSON.stringify(
                { config: node.config, inputs: node.inputs },
                null,
                2,
              ),
            );
        }}
      >
        <summary>编辑配置与输入 JSON</summary>
        <textarea
          aria-label="节点配置 JSON"
          rows={12}
          value={advanced}
          onChange={(e) => setAdvanced(e.target.value)}
        />
        <button
          onClick={() => {
            try {
              const data = JSON.parse(advanced);
              const parsed = nodeSchema.safeParse({
                ...node,
                config: data.config,
                inputs: data.inputs,
              });
              if (!parsed.success)
                throw new Error(
                  parsed.error.issues
                    .map((i) => `${i.path.join(".")}: ${i.message}`)
                    .join("；"),
                );
              update(parsed.data);
              setError("");
            } catch (e) {
              setError(e instanceof Error ? e.message : "JSON 无效");
            }
          }}
        >
          应用配置
        </button>
        {error && (
          <p className={cx("config-error")} role="alert">
            {error}
          </p>
        )}
      </details>
      <button className={cx("danger-outline")} onClick={remove}>
        删除节点
      </button>
    </>
  );
}
