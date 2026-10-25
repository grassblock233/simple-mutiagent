import { type RunState } from "./schema";

export const conclusions = {
  passed: "通过",
  issues_remaining: "仍有问题",
  validation_incomplete: "验证未完成",
  execution_failed: "执行失败",
  cancelled: "已取消",
};
export const statuses = {
  pending: "待运行",
  running: "运行中",
  awaiting_approval: "等待审核",
  finalizing: "正在整理与检查差异",
  awaiting_confirmation: "等待文件确认",
  completed: "完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
export const applicationStatuses = { not_applied: "未应用", awaiting_confirmation: "等待确认", applied: "已应用", apply_failed: "应用失败", undone: "已撤销" };
export function markdownReport(state: RunState) {
  const usage = state.usage ?? [];
  const known = usage.length > 0 && usage.every(u => u.cacheHitTokens !== null && u.cacheMissTokens !== null && u.completionTokens !== null && !u.uncertain);
  const low = known ? usage.reduce((n, u) => n + (u.cacheHitTokens! * 0.02 + u.cacheMissTokens! + u.completionTokens! * 4) / 1_000_000, 0) : null;
  const lines = [
    "# Simple Workflow 审查与修复报告",
    "",
    "> 本机执行，未启用文件与网络隔离。代码通过 DeepSeek API 处理。命令及子进程可能访问宿主文件和网络；文件应用及撤销仅覆盖登记的事务变更。",
    "",
    `- 运行：${state.id}`,
    `- 工作流：${state.workflow.name}`,
    `- 状态：${statuses[state.status]}`,
    `- 结论：${state.conclusion ? conclusions[state.conclusion] : "尚未得出"}`,
    ...(state.reviewConclusion ? [`- 文件事务前的审查结论：${conclusions[state.reviewConclusion]}（当前事务状态见下）`] : []),
    `- 修复轮次：${state.round}/${state.maxRounds}`,
    `- 工作区：${state.workspace?.root ?? "未知工作区"}`,
    `- 范围：${state.scope.join(", ")}`,
    `- 版本：${state.baselineVersion} → ${state.currentVersion}`,
    `- 停止原因：${state.exitReason ?? "运行中"}`,
    `- 应用状态：${applicationStatuses[state.applicationStatus]}${state.applicationError ? `；${state.applicationError}` : ""}`,
    `- 修复模式快照：${state.repairMode}`,
    `- 模型调用：${usage.length} 次；实际 usage 见明细，缺失字段为未知。${low === null ? "费用估算未知。" : `按 2026-10-14 价格快照估算人民币 ${low.toFixed(6)}–${(low * 2).toFixed(6)} 元（空闲/高峰范围，非账单）。`}`,
    "",
    ...["## 执行预算与限制", "", "目标平台：Linux；副本只复制普通文本，不复制 node_modules，不自动安装依赖。需要未准备依赖的检查不能作为通过证据。", "", "项目文件数量与总文本量不限；单文件 1 MiB、单次读取 256 KiB，可分页读取。模型请求轮数、工具调用次数与节点累计读取量不限；接近供应商上下文窗口时自动压缩历史，摘要不替代读取或验证证据。输出采用 DeepSeek 默认值或节点显式配置（1–393216 tokens）。节点总耗时 10 分钟（含审核等待）；模型请求/命令各 120 秒，命令每路输出最多 1 MiB。HTTP 429/5xx 最多尝试 3 次，失败尝试的用量或未知结果独立记录。", ""],
    "## 节点与各轮结果",
    "",
  ];
  for (const record of state.records) {
    lines.push(
      `### ${record.nodeId} · 第 ${record.round} 轮 · ${record.status}`,
      "",
      `输入版本：${record.inputVersion}`,
      "",
      "```json",
      JSON.stringify(
        { input: record.input, output: record.output, error: record.error },
        null,
        2,
      ),
      "```",
      "",
    );
  }
  lines.push(
    "## 命令审核",
    "",
    "```json",
    JSON.stringify(state.approvals, null, 2),
    "```",
    "",
    "## 最终问题",
    "",
    "```json",
    JSON.stringify(state.issues, null, 2),
    "```",
    "",
    "## 事件",
    "",
  );
  for (const [title, value] of [
    ["固定工作区与排除规则", state.workspace],
    ["读取路径及版本", state.reads],
    ["真实命令与验证（拒绝、截断、超时和取消均保留）", state.commands],
    ["最终整批差异", state.changes],
    ["文件应用与恢复事务", state.transaction],
    ["模型用量与未知请求", state.usage],
  ] as const) lines.push(`## ${title}`, "", "```json", JSON.stringify(value ?? null, null, 2), "```", "");
  state.events.forEach((event) =>
    lines.push(`- ${event.seq}. ${event.time} ${event.message}`),
  );
  return lines.join("\n");
}
