import { test } from "node:test";
import assert from "node:assert/strict";
import { createNode, createTemplate } from "../lib/workflow/templates";
import { validateWorkflow } from "../lib/workflow/validate";
import type { NodeRunner } from "../lib/workflow/engine";
import { TestWorkflowEngine as WorkflowEngine } from "./engine-fixture";
import { matchesCondition, reviewFacts } from "../lib/workflow/conditions";
import { type CommandSpec } from "../lib/workflow/engine";
import {
  type ReviewResult,
  type RunState,
  type Workflow,
} from "../lib/workflow/schema";
import { markdownReport } from "../lib/workflow/report";
import { newestSnapshot } from "../lib/workflow/snapshot";

const command: CommandSpec = {
  executable: "node",
  args: ["--test", "src/math.test.ts"],
  cwd: ".",
  purpose: "测试夹具测试",
  artifacts: [],
};
function review(state: RunState, resolved = false): ReviewResult {
  return {
    type: "review",
    version: state.currentVersion,
    scope: state.scope,
    validations: [],
    limitations: ["测试夹具结果"],
    issues: [
      {
        id: state.issues[0]?.id ?? "candidate",
        path: "src/math.ts",
        version: state.currentVersion,
        startLine: 1,
        endLine: 1,
        description: "测试夹具问题",
        evidence: "测试夹具证据",
        suggestion: "测试夹具建议",
        severity: "blocking",
        status: resolved ? "resolved" : "open",
      },
    ],
  };
}
function runner(
  options: {
    clean?: boolean;
    persistent?: boolean;
    calls?: string[];
    approval?: boolean;
  } = {},
): NodeRunner {
  return async ({ node, state, requestApproval }) => {
    options.calls?.push(node.kind);
    if (node.kind === "read")
      return {
        type: "material",
        version: state.baselineVersion,
        paths: state.scope,
      };
    if (node.kind === "repair")
      return {
        type: "repair",
        basedOnVersion: state.currentVersion,
        version: `test-v${state.round}`,
        changes: [{ path: "src/math.ts", before: "a-b", after: "a+b" }],
        resolutions: [],
        unrepairable: [],
      };
    const result = review(
      state,
      node.kind === "rereview" && !options.persistent,
    );
    if (options.clean) result.issues = [];
    if (options.approval) {
      const decision = await requestApproval(command);
      result.validations = [
        {
          name: "测试夹具验证",
          status: decision === "approved" ? "passed" : "missing",
          required: true,
        },
      ];
    }
    return result;
  };
}
function invalid(mutate: (workflow: Workflow) => void, code: string) {
  const flow = createTemplate();
  mutate(flow);
  assert.ok(
    validateWorkflow(flow).errors.some((error) => error.code === code),
    JSON.stringify(validateWorkflow(flow).errors),
  );
  assert.throws(() => new WorkflowEngine(flow, runner()));
}
async function waitUntil(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("等待状态超时");
}

test("两个默认模板通过完整格式与语义校验", () => {
  assert.equal(validateWorkflow(createTemplate()).valid, true);
  assert.equal(validateWorkflow(createTemplate("review")).valid, true);
});
test("旧版和额外的权限/密钥字段被拒绝，不静默丢弃", () => {
  assert.equal(
    validateWorkflow({ ...createTemplate(), formatVersion: 2 }).valid,
    false,
  );
  assert.equal(
    validateWorkflow({ ...createTemplate(), apiKey: "example" }).valid,
    false,
  );
});
test("非法 JSON 结构返回校验错误，不抛异常", () => {
  for (const value of [null, 1, [], { nodes: null }, { nodes: [null] }])
    assert.equal(validateWorkflow(value).valid, false);
});
test("端口错误阻止启动", () =>
  invalid((w) => {
    w.edges[0].sourcePort = "exit";
  }, "port"));
test("出口不允许空缺或并行", () => {
  invalid((w) => {
    w.edges.pop();
  }, "outlet");
  invalid((w) => {
    w.edges.push({ ...w.edges[0], id: "parallel", target: "output" });
  }, "outlet");
});
test("普通回边和嵌套循环被拒绝", () => {
  invalid((w) => {
    w.edges.find((e) => e.source === "rereview")!.target = "repair";
  }, "cycle");
  invalid((w) => {
    w.nodes.push(createNode("loop", "nested"));
  }, "loop_count");
});
test("循环回边必须指向明确的修复入口", () =>
  invalid((w) => {
    w.edges.find((e) => e.sourcePort === "continue")!.target = "review";
  }, "loop_entry"));
test("不可达节点与无终点路径被定位", () =>
  invalid((w) => {
    w.nodes.push(createNode("review", "unused"));
  }, "unreachable"));
test("数据类型、缺失来源和分支路径输入被拒绝", () => {
  invalid((w) => {
    const n = w.nodes.find((n) => n.kind === "repair")!;
    if (n.kind === "repair") n.inputs.review.output = "material";
  }, "data_type");
  invalid((w) => {
    const n = w.nodes.find((n) => n.kind === "repair")!;
    if (n.kind === "repair") n.inputs.review.sources = ["missing"];
  }, "data_source");
  invalid((w) => {
    const n = w.nodes.find((n) => n.kind === "repair")!;
    if (n.kind === "repair") n.inputs.review.sources = ["rereview"];
  }, "data_path");
});
test("修复后的分支不能引用初始审查", () =>
  invalid((w) => {
    const n = w.nodes.find((n) => n.id === "final_branch")!;
    if (n.kind === "branch") n.inputs.review.sources = ["review"];
  }, "data_version_path"));
test("输出不能绕过审查", () =>
  invalid((w) => {
    w.edges[0].target = "output";
  }, "output_review"));
test("修复必须先复审再输出", () =>
  invalid((w) => {
    w.edges.find((e) => e.source === "repair")!.target = "output";
  }, "repair_review"));
test("条件字段与操作符实行白名单", () => {
  const workflow = createTemplate();
  const branch = workflow.nodes.find((n) => n.kind === "branch")!;
  assert.equal(
    validateWorkflow({
      ...workflow,
      nodes: workflow.nodes.map((n) =>
        n === branch
          ? {
              ...n,
              config: {
                conditions: [
                  {
                    id: "execute",
                    field: "eval",
                    operator: "run",
                    value: "process.exit()",
                  },
                ],
              },
            }
          : n,
      ),
    }).valid,
    false,
  );
});
test("一轮内修复并复审通过，原输入对象不可变", async () => {
  const flow = createTemplate();
  const calls: string[] = [];
  const engine = new WorkflowEngine(flow, runner({ calls }));
  flow.name = "changed";
  const promise = engine.start();
  assert.equal(engine.start(), promise);
  await promise;
  const state = engine.snapshot();
  assert.equal(state.conclusion, "passed");
  assert.equal(state.round, 1);
  assert.deepEqual(calls, ["read", "review", "repair", "rereview"]);
  assert.notEqual(state.workflow.name, flow.name);
  assert.equal(state.issues[0].status, "resolved");
  assert.equal(state.applicationStatus, "not_applied");
  assert.deepEqual(
    state.events.map((e) => e.seq),
    Array.from({ length: state.events.length }, (_, i) => i + 1),
  );
});
test("无阻塞问题直接输出，互斥路径标记跳过", async () => {
  const calls: string[] = [];
  const engine = new WorkflowEngine(
    createTemplate(),
    runner({ clean: true, calls }),
  );
  await engine.start();
  const state = engine.snapshot();
  assert.equal(state.conclusion, "passed");
  assert.equal(state.round, 0);
  assert.deepEqual(calls, ["read", "review"]);
  assert.equal(
    state.records.find((r) => r.kind === "repair")?.status,
    "skipped",
  );
});
test("仅审查模板不执行修复", async () => {
  const calls: string[] = [];
  const engine = new WorkflowEngine(
    createTemplate("review"),
    runner({ calls }),
  );
  await engine.start();
  assert.equal(engine.snapshot().conclusion, "issues_remaining");
  assert.deepEqual(calls, ["read", "review"]);
});
for (const maxRounds of [1, 2, 5])
  test(`持续问题严格停止在 ${maxRounds} 轮`, async () => {
    const flow = createTemplate();
    const loop = flow.nodes.find((n) => n.kind === "loop")!;
    if (loop.kind === "loop") loop.config.maxRounds = maxRounds;
    const calls: string[] = [];
    const engine = new WorkflowEngine(
      flow,
      runner({ persistent: true, calls }),
    );
    await engine.start();
    const state = engine.snapshot();
    assert.equal(state.round, maxRounds);
    assert.equal(state.conclusion, "issues_remaining");
    assert.equal(calls.filter((k) => k === "repair").length, maxRounds);
    assert.match(state.exitReason!, /上限/);
    assert.deepEqual(
      state.records.filter((r) => r.kind === "repair").map((r) => r.round),
      Array.from({ length: maxRounds }, (_, i) => i + 1),
    );
    assert.equal(state.issues[0].id, "I-1");
  });
test("多个条件命中使用第一条，未命中使用兜底", async () => {
  const flow = createTemplate();
  const branch = flow.nodes.find((n) => n.id === "initial_branch")!;
  if (branch.kind === "branch")
    branch.config.conditions.push({
      id: "second",
      field: "blockingCount",
      operator: "gt",
      value: 0,
    });
  flow.edges.push({
    id: "second-edge",
    source: branch.id,
    sourcePort: "second",
    target: "output",
    targetPort: "in",
  });
  const engine = new WorkflowEngine(flow, runner());
  await engine.start();
  assert.deepEqual(
    engine.snapshot().records.find((r) => r.nodeId === "initial_branch")
      ?.output,
    {
      type: "decision",
      port: "has_issues",
      reason: "按显式顺序选择 has_issues",
    },
  );
});
test("结构缺失、错版本和失败验证不能判通过", async () => {
  for (const raw of [{ type: "review" }, "natural language", null]) {
    const fallback = runner();
    const engine = new WorkflowEngine(createTemplate(), async (ctx) =>
      ctx.node.kind === "review" ? raw : fallback(ctx),
    );
    await engine.start();
    assert.equal(engine.snapshot().conclusion, "execution_failed");
  }
  for (const change of [
    (r: ReviewResult) => {
      r.version = "stale";
    },
    (r: ReviewResult) => {
      r.validations = [{ name: "test", required: true, status: "failed" }];
    },
  ]) {
    const fallback = runner();
    const engine = new WorkflowEngine(createTemplate(), async (ctx) => {
      const result = await fallback(ctx);
      if (ctx.node.kind === "review") change(result as ReviewResult);
      return result;
    });
    await engine.start();
    assert.equal(engine.snapshot().conclusion, "execution_failed");
  }
});
test("必要验证缺失优先于剩余问题，不进入修复", async () => {
  const flow = createTemplate();
  const node = flow.nodes.find((n) => n.kind === "review")!;
  if (node.kind === "review") node.config.requireValidation = true;
  const calls: string[] = [];
  const engine = new WorkflowEngine(flow, runner({ calls }));
  await engine.start();
  assert.equal(engine.snapshot().conclusion, "validation_incomplete");
  assert.equal(engine.snapshot().round, 0);
  assert.equal(engine.snapshot().issues.length, 1);
});
test("复审遗漏原问题保留无法确认，不凭遗漏消除问题", async () => {
  const fallback = runner();
  const engine = new WorkflowEngine(createTemplate(), async (ctx) => {
    const result = await fallback(ctx);
    if (ctx.node.kind === "rereview") (result as ReviewResult).issues = [];
    return result;
  });
  await engine.start();
  assert.equal(engine.snapshot().conclusion, "issues_remaining");
  assert.equal(engine.snapshot().issues[0].status, "unconfirmed");
  assert.equal(engine.snapshot().issues[0].version, "test-v0");
});
test("审核绑定哈希且只能消费一次；后续请求使用新标识", async () => {
  const engine = new WorkflowEngine(
    createTemplate(),
    runner({ approval: true }),
  );
  const done = engine.start();
  await waitUntil(() => engine.snapshot().status === "awaiting_approval");
  const first = engine.snapshot().approvals[0];
  assert.throws(
    () => engine.decideApproval(first.id, "wrong", "approved"),
    /不匹配/,
  );
  engine.decideApproval(first.id, first.displayHash, "approved");
  assert.throws(
    () => engine.decideApproval(first.id, first.displayHash, "approved"),
    /过期|消费/,
  );
  await waitUntil(() => engine.snapshot().approvals.length === 2);
  const second = engine.snapshot().approvals[1];
  assert.notEqual(first.id, second.id);
  assert.equal(second.status, "pending");
  engine.decideApproval(second.id, second.displayHash, "approved");
  await done;
  assert.equal(engine.snapshot().conclusion, "passed");
});
test("拒绝必要审核不会修复或自动应用", async () => {
  const engine = new WorkflowEngine(
    createTemplate(),
    runner({ approval: true }),
    { repairMode: "automatic" },
  );
  const done = engine.start();
  await waitUntil(() => engine.snapshot().status === "awaiting_approval");
  const approval = engine.snapshot().approvals[0];
  engine.decideApproval(approval.id, approval.displayHash, "rejected");
  await done;
  assert.equal(engine.snapshot().conclusion, "validation_incomplete");
  assert.equal(engine.snapshot().round, 0);
  assert.equal(engine.snapshot().applicationStatus, "not_applied");
});
test("相同版本被拒绝的动作不能靠再次请求绕过", async () => {
  let second: string | undefined;
  const fallback = runner();
  const engine = new WorkflowEngine(createTemplate(), async (ctx) => {
    if (ctx.node.kind !== "review") return fallback(ctx);
    await ctx.requestApproval(command);
    second = await ctx.requestApproval(command);
    return review(ctx.state);
  });
  const done = engine.start();
  await waitUntil(() => engine.snapshot().status === "awaiting_approval");
  const a = engine.snapshot().approvals[0];
  engine.decideApproval(a.id, a.displayHash, "rejected");
  await done;
  assert.equal(second, "rejected");
  assert.equal(engine.snapshot().approvals.length, 1);
});
test("界面断开使待审请求过期，不能迟到批准", async () => {
  const engine = new WorkflowEngine(
    createTemplate(),
    runner({ approval: true }),
  );
  const done = engine.start();
  await waitUntil(() => engine.snapshot().status === "awaiting_approval");
  const a = engine.snapshot().approvals[0];
  engine.expireApprovals("界面关闭");
  assert.throws(() => engine.decideApproval(a.id, a.displayHash, "approved"));
  await done;
  assert.equal(engine.snapshot().approvals[0].status, "expired");
  assert.equal(engine.snapshot().conclusion, "validation_incomplete");
});
test("审核等待时取消，所有待定请求过期", async () => {
  const engine = new WorkflowEngine(
    createTemplate(),
    runner({ approval: true }),
  );
  const done = engine.start();
  await waitUntil(() => engine.snapshot().status === "awaiting_approval");
  engine.cancel();
  await done;
  assert.equal(engine.snapshot().status, "cancelled");
  assert.equal(engine.snapshot().approvals[0].status, "expired");
});
test("取消后迟到结果不更新状态且不能重新启动", async () => {
  let release!: (value: unknown) => void;
  const engine = new WorkflowEngine(
    createTemplate(),
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const done = engine.start();
  engine.cancel();
  release({
    type: "material",
    version: "test-v0",
    paths: ["src/math.ts", "src/math.test.ts"],
  });
  await done;
  assert.equal(engine.snapshot().status, "cancelled");
  assert.equal(engine.snapshot().records[0].status, "cancelled");
  const pending = new WorkflowEngine(createTemplate(), runner());
  pending.cancel();
  await pending.start();
  assert.equal(pending.snapshot().status, "cancelled");
});
test("越界修复和非白名单命令失败收束", async () => {
  const fallback = runner();
  for (const variant of ["patch", "command"]) {
    const engine = new WorkflowEngine(createTemplate(), async (ctx) => {
      if (variant === "command" && ctx.node.kind === "review")
        await ctx.requestApproval({ ...command, executable: "sh" });
      const result = await fallback(ctx);
      if (variant === "patch" && ctx.node.kind === "repair")
        return {
          ...(result as object),
          changes: [{ path: "../secret", before: "x", after: "y" }],
        };
      return result;
    });
    await engine.start();
    assert.equal(engine.snapshot().conclusion, "execution_failed");
  }
});
test("条件缺失类型错误不能命中成功出口", () => {
  assert.throws(() =>
    matchesCondition(
      { id: "x", field: "testsPassed", operator: "eq", value: true },
      { blockingCount: 0, validationComplete: true } as ReturnType<
        typeof reviewFacts
      >,
    ),
  );
});
test("报告包含轮次、范围、验证限制及独立应用状态", async () => {
  const engine = new WorkflowEngine(createTemplate(), runner());
  await engine.start();
  const report = markdownReport(engine.snapshot());
  for (const token of [
    "审查与修复报告",
    "未启用文件与网络隔离",
    "模型调用：0 次",
    "未应用",
    "第 1 轮",
    "最终问题",
    "test-v0",
  ])
    assert.ok(report.includes(token));
});
test("不响应 AbortSignal 的执行器也不能阻塞取消收束", async () => {
  const engine = new WorkflowEngine(
    createTemplate(),
    async () => new Promise(() => {}),
  );
  const done = engine.start();
  engine.cancel();
  await done;
  assert.equal(engine.snapshot().status, "cancelled");
});
test("节点结束后的工具请求被拒绝", async () => {
  let late!: (command: CommandSpec) => Promise<string>;
  const fallback = runner();
  const engine = new WorkflowEngine(createTemplate(), async (ctx) => {
    if (ctx.node.kind === "review") late = ctx.requestApproval;
    return fallback(ctx);
  });
  await engine.start();
  await assert.rejects(() => late(command), /结束|过期/);
  assert.equal(engine.snapshot().approvals.length, 0);
});
test("迟到 HTTP 快照不能覆盖 SSE 的完成状态", async () => {
  const engine = new WorkflowEngine(createTemplate(), runner());
  const done = engine.start();
  const earlier = engine.snapshot();
  await done;
  const finished = engine.snapshot();
  assert.equal(newestSnapshot(finished, earlier).status, "completed");
  assert.equal(newestSnapshot(earlier, finished).status, "completed");
});
