"use client";
import type { Dispatch, SetStateAction } from "react";
import type { DemoScenario } from "@/lib/workflow/schema";
import type { Workspace } from "./studio-types";
import { cx } from "./studio-styles";
import { Icon } from "./studio-ui";
type Setter<T> = Dispatch<SetStateAction<T>>;
const scenarios: Record<DemoScenario, string> = {
  clean: "审查无阻塞问题",
  repairable: "修复后复审通过",
  persistent: "轮数内仍无法解决",
  validation: "逐次审核验证",
  failure: "模拟模型超时",
};
type Props = {
  mode: "real" | "demo";
  setMode: Setter<"real" | "demo">;
  scenario: DemoScenario;
  setScenario: Setter<DemoScenario>;
  repairMode: "confirm" | "automatic";
  setRepairMode: Setter<"confirm" | "automatic">;
  csrf: string;
  busy: boolean;
  running: boolean;
  valid: boolean;
  modelConfigured: boolean;
  workspace?: Workspace;
  selectionCount: number;
  onStart: () => void;
  onWorkspace: () => void;
};
export function RunSettings({
  mode,
  setMode,
  scenario,
  setScenario,
  repairMode,
  setRepairMode,
  csrf,
  busy,
  running,
  valid,
  modelConfigured,
  workspace,
  selectionCount,
  onStart,
  onWorkspace,
}: Props) {
  const missing = [
    !csrf && "正在连接本地服务",
    busy && "请等待当前操作完成",
    running && "请等待或取消当前运行",
    !valid && "请修正工作流校验错误",
    mode === "real" && !modelConfigured && "尚未配置模型密钥",
    mode === "real" && !workspace && "请打开一个本地项目",
    mode === "real" && !selectionCount && "请选择审查与修改范围",
  ].filter(Boolean);
  return (
    <div className={cx("run-settings")}>
      <div className={cx("mode-options")} role="group" aria-label="运行模式">
        <button
          aria-pressed={mode === "real"}
          className={cx(mode === "real" ? "mode-card active" : "mode-card")}
          onClick={() => setMode("real")}
        >
          <Icon name="folder" />
          <strong>真实工作流</strong>
        </button>
        <button
          aria-pressed={mode === "demo"}
          className={cx(mode === "demo" ? "mode-card active" : "mode-card")}
          onClick={() => setMode("demo")}
        >
          <Icon name="play" />
          <strong>合成演练</strong>
        </button>
      </div>
      {mode === "real" ? (
        <div className={cx("run-summary")}>
          <h3>项目与范围</h3>
          <p className={cx("path-label")}>
            {workspace?.root ?? "尚未连接项目"}
          </p>
          <p className={cx("help")}>已选择 {selectionCount} 项</p>
          <button onClick={onWorkspace}>
            <Icon name="folder" />
            选择工作区
          </button>
          {!modelConfigured && (
            <p className={cx("help")}>
              在 .env.local 中配置 DEEPSEEK_API_KEY 并重启服务后可启动真实运行。
            </p>
          )}
        </div>
      ) : (
        <label>
          合成场景
          <select
            value={scenario}
            onChange={(e) => setScenario(e.target.value as DemoScenario)}
          >
            {Object.entries(scenarios).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        修复写入模式
        <select
          value={repairMode}
          onChange={(e) =>
            setRepairMode(e.target.value as "confirm" | "automatic")
          }
        >
          <option value="confirm">确认后写入</option>
          <option value="automatic">自动写入</option>
        </select>
      </label>
      <div className={cx("launch-section")}>
        <button
          className={cx("primary launch-button")}
          disabled={missing.length > 0}
          onClick={onStart}
        >
          <Icon name="play" />
          {busy
            ? "正在启动…"
            : mode === "real"
              ? "运行真实工作流"
              : "运行合成演练"}
        </button>
        {missing.length > 0 ? (
          <ul className={cx("launch-reasons")}>
            {missing.map((reason) => (
              <li key={String(reason)}>{reason}</li>
            ))}
          </ul>
        ) : (
          <p className={cx("ready-label")}>
            <Icon name="check" />
            准备就绪
          </p>
        )}
      </div>
    </div>
  );
}
