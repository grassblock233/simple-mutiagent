import { z } from "zod";

export const FORMAT_VERSION = 1 as const;
export const nodeKinds = [
  "read",
  "review",
  "repair",
  "rereview",
  "branch",
  "loop",
  "output",
] as const;
export const labels: Record<NodeKind, string> = {
  read: "读取代码",
  review: "审查 Agent",
  repair: "修复 Agent",
  rereview: "复审 Agent",
  branch: "条件分支",
  loop: "循环控制",
  output: "输出结果",
};
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const text = z.string().trim().min(1).max(8000);
export const referenceSchema = z
  .object({
    sources: z.array(id).min(1).max(20),
    output: z.enum(["material", "review", "repair"]),
    freshness: z.enum(["baseline", "current"]),
  })
  .strict();
const agentConfig = z
  .object({
    model: z.literal("deepseek-flash"),
    prompt: text,
    thinking: z.boolean(),
    reasoningEffort: z.enum(["low", "high", "max"]),
    maxOutputTokens: z.number().int().min(256).max(16384),
    requireValidation: z.boolean(),
  })
  .strict();
export const conditionSchema = z.discriminatedUnion("field", [
  z
    .object({
      id,
      field: z.literal("blockingCount"),
      operator: z.enum(["eq", "gt"]),
      value: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      id,
      field: z.enum(["validationComplete", "testsPassed"]),
      operator: z.literal("eq"),
      value: z.boolean(),
    })
    .strict(),
]);
const common = {
  id,
  label: z.string().trim().min(1).max(80),
  position: z
    .object({ x: z.number().finite(), y: z.number().finite() })
    .strict(),
};
const empty = z.object({}).strict();
export const nodeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...common,
      kind: z.literal("read"),
      config: empty,
      inputs: empty,
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("review"),
      config: agentConfig,
      inputs: z.object({ material: referenceSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("repair"),
      config: agentConfig,
      inputs: z.object({ review: referenceSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("rereview"),
      config: agentConfig,
      inputs: z.object({ repair: referenceSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("branch"),
      config: z
        .object({ conditions: z.array(conditionSchema).min(1).max(10) })
        .strict(),
      inputs: z.object({ review: referenceSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("loop"),
      config: z
        .object({ entryNodeId: id, maxRounds: z.number().int().min(1).max(5) })
        .strict(),
      inputs: z.object({ review: referenceSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("output"),
      config: empty,
      inputs: empty,
    })
    .strict(),
]);
export const workflowSchema = z
  .object({
    formatVersion: z.literal(FORMAT_VERSION),
    name: z.string().trim().min(1).max(100),
    nodes: z.array(nodeSchema).min(2).max(50),
    edges: z
      .array(
        z
          .object({
            id,
            source: id,
            sourcePort: id,
            target: id,
            targetPort: z.literal("in"),
          })
          .strict(),
      )
      .max(150),
  })
  .strict();
export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowNode = z.infer<typeof nodeSchema>;
export type NodeKind = (typeof nodeKinds)[number];
export type DataReference = z.infer<typeof referenceSchema>;
export type Condition = z.infer<typeof conditionSchema>;

const relativePath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.split("/").some((s) => !s || s === "." || s === ".."),
    "必须是工作区内的相对路径",
  );
export const issueSchema = z
  .object({
    id,
    path: relativePath,
    version: text,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    severity: z.enum(["blocking", "suggestion"]),
    description: text,
    evidence: text,
    suggestion: text,
    status: z.enum(["open", "resolved", "unconfirmed"]),
  })
  .strict()
  .refine((issue) => issue.endLine >= issue.startLine, "结束行不能小于起始行");
export const reviewResultSchema = z
  .object({
    type: z.literal("review"),
    version: text,
    scope: z.array(relativePath).min(1),
    issues: z.array(issueSchema).max(200),
    validations: z.array(
      z
        .object({
          name: text,
          status: z.enum(["passed", "failed", "missing"]),
          required: z.boolean(),
        })
        .strict(),
    ),
    limitations: z.array(text),
  })
  .strict();
export const repairResultSchema = z
  .object({
    type: z.literal("repair"),
    basedOnVersion: text,
    version: text,
    changes: z
      .array(
        z
          .object({
            path: relativePath,
            before: z.string().nullable(),
            after: z.string().nullable(),
          })
          .strict(),
      )
      .max(100),
    resolutions: z.array(z.object({ issueId: id, explanation: text }).strict()),
    unrepairable: z.array(text),
  })
  .strict();
export const materialSchema = z
  .object({
    type: z.literal("material"),
    version: text,
    paths: z.array(relativePath).min(1),
  })
  .strict();
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export type RepairResult = z.infer<typeof repairResultSchema>;
export type MaterialResult = z.infer<typeof materialSchema>;
export type NodeOutput =
  | MaterialResult
  | ReviewResult
  | RepairResult
  | { type: "decision"; port: string; reason: string }
  | { type: "report"; conclusion: Conclusion };

export type RunStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "finalizing"
  | "awaiting_confirmation"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type Conclusion =
  | "passed"
  | "issues_remaining"
  | "validation_incomplete"
  | "execution_failed"
  | "cancelled";
export type NodeStatus =
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";
export type NodeRecord = {
  formatVersion: 1;
  runId: string;
  id: string;
  nodeId: string;
  kind: NodeKind;
  round: number;
  inputVersion: string;
  startedAt: string;
  finishedAt?: string;
  status: NodeStatus;
  input: Record<string, NodeOutput>;
  output?: NodeOutput;
  error?: string;
};
export type ApprovalRequest = {
  id: string;
  runId: string;
  nodeId: string;
  round: number;
  version: string;
  executable: string;
  args: string[];
  cwd: string;
  purpose: string;
  artifacts: string[];
  environment: "local-minimal-env-v1";
  displayHash: string;
  status: "pending" | "approved" | "rejected" | "expired";
  createdAt: string;
  decidedAt?: string;
};
export type RunEvent = {
  seq: number;
  runId: string;
  time: string;
  type: string;
  message: string;
  nodeId?: string;
};
export type RunState = {
  formatVersion: 1;
  id: string;
  mode: "real";
  workflow: Workflow;
  scope: string[];
  repairMode: "confirm" | "automatic";
  status: RunStatus;
  currentNodeId?: string;
  round: number;
  maxRounds: number;
  baselineVersion: string;
  currentVersion: string;
  records: NodeRecord[];
  issues: z.infer<typeof issueSchema>[];
  approvals: ApprovalRequest[];
  events: RunEvent[];
  conclusion?: Conclusion;
  exitReason?: string;
  applicationStatus: "not_applied" | "awaiting_confirmation" | "applied" | "apply_failed" | "undone";
  workspace?: { id: string; root: string; selection: { path: string; directory: boolean }[]; excludes: string[] };
  changes?: { path: string; before: string | null; after: string | null }[];
  reads?: { path: string; version: string; startLine: number; endLine: number; nodeId: string }[];
  commands?: import("../runtime/commands").CommandRecord[];
  reviewConclusion?: Conclusion;
  usage?: { nodeId: string; model: string; time: string; durationMs: number; promptTokens: number | null; completionTokens: number | null; cacheHitTokens: number | null; cacheMissTokens: number | null; uncertain?: boolean }[];
  transaction?: import("../runtime/transaction").Transaction;
  applicationError?: string;
  createdAt: string;
  finishedAt?: string;
};
