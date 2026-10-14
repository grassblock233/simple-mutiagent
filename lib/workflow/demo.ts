import { type NodeRunner } from "./engine";
import { type ReviewResult } from "./schema";

export const demoRunner: NodeRunner = async ({
  node,
  state,
  signal,
  requestApproval,
}) => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, 300);
    const cancel = () => {
      clearTimeout(timer);
      reject(new Error("演练已取消"));
    };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
  if (node.kind === "read")
    return {
      type: "material",
      version: state.currentVersion,
      paths: state.scope,
    };
  if (state.scenario === "failure" && node.kind === "review")
    throw new Error("合成模型超时，用于验证失败收束");
  if (node.kind === "repair")
    return {
      type: "repair",
      basedOnVersion: state.currentVersion,
      version: `demo-v${state.round}`,
      changes: [
        {
          path: "src/math.ts",
          before: "export const add = (a, b) => a - b;",
          after: "export const add = (a, b) => a + b;",
        },
      ],
      resolutions: state.issues.map((i) => ({
        issueId: i.id,
        explanation: "合成修复：将减法改为加法",
      })),
      unrepairable: [],
    };
  const validations: ReviewResult["validations"] = [];
  if (
    state.scenario === "validation" ||
    ((node.kind === "review" || node.kind === "rereview") &&
      node.config.requireValidation)
  ) {
    const decision = await requestApproval({
      executable: "node",
      args: ["--test", "src/math.test.ts"],
      cwd: ".",
      purpose: "演练逐次命令审核，不执行真实进程",
      artifacts: ["合成验证记录"],
    });
    validations.push({
      name: "合成测试（未启动进程）",
      required: true,
      status: decision === "approved" ? "passed" : "missing",
    });
  }
  const hasIssue = state.scenario !== "clean";
  const resolved = node.kind === "rereview" && state.scenario !== "persistent";
  return {
    type: "review",
    version: state.currentVersion,
    scope: state.scope,
    validations,
    limitations: [
      "结果为固定合成数据，未读取工作区、调用 DeepSeek 或执行测试；不能作为真实审查结论。",
    ],
    issues: hasIssue
      ? [
          {
            id: state.issues[0]?.id ?? "candidate",
            path: "src/math.ts",
            version: state.currentVersion,
            startLine: 1,
            endLine: 1,
            severity: "blocking",
            description: "add 函数返回减法结果（合成问题）",
            evidence: "add(2, 1) 的合成结果为 1，预期为 3",
            suggestion: "使用 a + b",
            status: resolved ? "resolved" : "open",
          },
        ]
      : [],
  };
};
