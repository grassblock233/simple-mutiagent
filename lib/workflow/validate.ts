import { workflowSchema, type Workflow } from "./schema";
import { outputPorts } from "./templates";

export type WorkflowError = {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
};
export type Validation = {
  valid: boolean;
  errors: WorkflowError[];
  workflow?: Workflow;
};

export function validateWorkflow(value: unknown): Validation {
  const parsed = workflowSchema.safeParse(value);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((issue) => ({
        code: "format",
        message: `${issue.path.join(".") || "workflow"}: ${issue.message}`,
        nodeId:
          typeof issue.path[1] === "number" && issue.path[0] === "nodes"
            ? (value as Workflow)?.nodes?.[issue.path[1]]?.id
            : undefined,
      })),
    };
  }
  const workflow = parsed.data;
  const errors: WorkflowError[] = [];
  const add = (
    code: string,
    message: string,
    nodeId?: string,
    edgeId?: string,
  ) => errors.push({ code, message, nodeId, edgeId });
  const nodes = new Map(workflow.nodes.map((n) => [n.id, n]));
  if (nodes.size !== workflow.nodes.length)
    add("duplicate_node", "节点标识重复；请使用唯一标识。");
  if (new Set(workflow.edges.map((e) => e.id)).size !== workflow.edges.length)
    add("duplicate_edge", "连线标识重复。");
  const read = workflow.nodes.filter((n) => n.kind === "read");
  const outputs = workflow.nodes.filter((n) => n.kind === "output");
  const loops = workflow.nodes.filter((n) => n.kind === "loop");
  const repairs = workflow.nodes.filter((n) => n.kind === "repair");
  const rereviews = workflow.nodes.filter((n) => n.kind === "rereview");
  if (read.length !== 1) add("entry", "必须有且只有一个读取代码入口。");
  if (!outputs.length) add("terminal", "请添加输出结果终点。");
  if (loops.length > 1)
    add("loop_count", "第一版只允许一个受控循环，不支持嵌套或交叉循环。");
  if (repairs.length > 1 || rereviews.length > 1)
    add("repair_count", "第一版只允许一个修复节点和一个复审节点。");
  if (repairs.length !== rereviews.length)
    add("repair_pair", "修复必须配有独立复审节点。");

  const isBackEdge = (e: Workflow["edges"][number]) =>
    nodes.get(e.source)?.kind === "loop" && e.sourcePort === "continue";
  const forward = workflow.edges.filter((e) => !isBackEdge(e));
  const adjacent = (nodeId: string, edges = forward) =>
    edges.filter((e) => e.source === nodeId).map((e) => e.target);
  function reachable(
    start: string,
    target: string,
    edges = forward,
    excluded = new Set<string>(),
  ) {
    const seen = new Set<string>();
    const visit = (at: string): boolean => {
      if (excluded.has(at) || seen.has(at)) return false;
      if (at === target) return true;
      seen.add(at);
      return adjacent(at, edges).some(visit);
    };
    return visit(start);
  }

  for (const edge of workflow.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) {
      add("dangling_edge", "连线引用了不存在的节点。", undefined, edge.id);
      continue;
    }
    if (!outputPorts(source).includes(edge.sourcePort))
      add("port", "出口与节点类型不匹配，请重新连线。", source.id, edge.id);
    if (target.kind === "read")
      add("entry_incoming", "读取代码入口不能有入边。", target.id, edge.id);
    if (source.id === target.id)
      add("self_edge", "节点不能连接自身。", source.id, edge.id);
  }
  for (const node of workflow.nodes) {
    for (const port of outputPorts(node)) {
      const edges = workflow.edges.filter(
        (e) => e.source === node.id && e.sourcePort === port,
      );
      if (edges.length !== 1)
        add("outlet", `出口 ${port} 必须连接且只能连接一个节点。`, node.id);
    }
    if (
      node.kind === "output" &&
      workflow.edges.some((e) => e.source === node.id)
    )
      add("terminal_outlet", "输出结果不能有出口。", node.id);
    if (node.kind === "branch") {
      const ids = node.config.conditions.map((c) => c.id);
      if (ids.includes("fallback") || new Set(ids).size !== ids.length)
        add("conditions", "分支条件标识必须唯一且不能使用 fallback。", node.id);
    }
    if (node.kind === "loop") {
      const entry = nodes.get(node.config.entryNodeId);
      const back = workflow.edges.find(
        (e) => e.source === node.id && e.sourcePort === "continue",
      );
      if (entry?.kind !== "repair" || back?.target !== entry.id)
        add(
          "loop_entry",
          "continue 必须指向配置中指定的修复入口。",
          node.id,
          back?.id,
        );
      if (entry && !reachable(entry.id, node.id))
        add("loop_region", "循环入口必须能经复审到达循环控制节点。", node.id);
      if (
        rereviews[0] &&
        entry &&
        reachable(entry.id, node.id, forward, new Set([rereviews[0].id]))
      )
        add("loop_review", "循环不能绕过复审。", node.id);
    }
  }

  // Removing the only permitted back edge must leave a DAG.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const checkCycle = (at: string) => {
    if (visiting.has(at)) {
      add("cycle", "发现普通回边；回边只能由循环控制的 continue 发出。", at);
      return;
    }
    if (visited.has(at)) return;
    visiting.add(at);
    adjacent(at).forEach(checkCycle);
    visiting.delete(at);
    visited.add(at);
  };
  workflow.nodes.forEach((n) => checkCycle(n.id));
  for (const node of workflow.nodes) {
    if (read.length === 1 && !reachable(read[0].id, node.id))
      add("unreachable", "节点无法从入口到达，请连接或删除。", node.id);
    if (!outputs.some((o) => reachable(node.id, o.id)))
      add("no_terminal", "此路径无法到达输出结果。", node.id);
    if (
      node.kind === "output" &&
      read[0] &&
      reachable(
        read[0].id,
        node.id,
        forward,
        new Set(
          workflow.nodes
            .filter((n) => n.kind === "review" || n.kind === "rereview")
            .map((n) => n.id),
        ),
      )
    )
      add("output_review", "每条输出路径都必须先完成审查。", node.id);
    if (
      repairs[0] &&
      rereviews[0] &&
      node.kind === "repair" &&
      outputs.some((o) =>
        reachable(node.id, o.id, forward, new Set([rereviews[0].id])),
      )
    )
      add("repair_review", "修复后所有路径必须先复审再输出。", node.id);
    for (const [slot, ref] of Object.entries(node.inputs)) {
      const expected =
        slot === "material"
          ? "material"
          : slot === "repair"
            ? "repair"
            : "review";
      if (ref.output !== expected)
        add("data_type", `输入 ${slot} 的结果类型不匹配。`, node.id);
      if (ref.freshness !== (expected === "material" ? "baseline" : "current"))
        add("freshness", `输入 ${slot} 的版本策略不匹配。`, node.id);
      for (const sourceId of ref.sources) {
        const source = nodes.get(sourceId);
        const type =
          source?.kind === "read"
            ? "material"
            : source?.kind === "review" || source?.kind === "rereview"
              ? "review"
              : source?.kind === "repair"
                ? "repair"
                : undefined;
        if (type !== expected)
          add(
            "data_source",
            `输入 ${slot} 来源 ${sourceId} 不存在或类型不匹配。`,
            node.id,
          );
        if (sourceId === node.id)
          add("data_self", "节点不能引用自身输出。", node.id);
      }
      // Any entry path avoiding all candidates is a path with missing input.
      if (
        read[0] &&
        reachable(read[0].id, node.id, forward, new Set(ref.sources))
      )
        add(
          "data_path",
          `并非每条执行路径都提供输入 ${slot}，请调整数据来源或连线。`,
          node.id,
        );
      if (
        ref.freshness === "current" &&
        repairs[0] &&
        node.id !== repairs[0].id &&
        reachable(repairs[0].id, node.id, forward, new Set(ref.sources))
      )
        add(
          "data_version_path",
          `修复后的路径未提供当前版本输入 ${slot}，不能复用修复前结果。`,
          node.id,
        );
    }
  }
  return { valid: errors.length === 0, errors, workflow };
}
