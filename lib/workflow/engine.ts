import { createHash, randomUUID } from "node:crypto";
import {
  materialSchema,
  repairResultSchema,
  reviewResultSchema,
  type ApprovalRequest,
  type Conclusion,
  type DataReference,
  type NodeOutput,
  type NodeRecord,
  type ReviewResult,
  type RunState,
  type Workflow,
  type WorkflowNode,
} from "./schema";
import { matchesCondition, reviewFacts } from "./conditions";
import { validateWorkflow } from "./validate";
import { ValidationIncompleteError } from "./errors";

export type CommandSpec = Pick<
  ApprovalRequest,
  "executable" | "args" | "cwd" | "purpose" | "artifacts"
>;
export type RunnerContext = {
  node: WorkflowNode;
  input: Record<string, NodeOutput>;
  state: RunState;
  signal: AbortSignal;
  syncVersion: (version: string) => void;
  update: (patch: Partial<Pick<RunState, "reads" | "commands" | "usage" | "changes" | "compactions">>, message: string) => void;
  requestApproval: (command: CommandSpec) => Promise<"approved" | "rejected">;
};
export type NodeRunner = (context: RunnerContext) => Promise<unknown>;
const active = new Set(["pending", "running", "awaiting_approval"]);

/** Serial scheduler. Files, providers and processes stay behind the injected runner. */
export class WorkflowEngine {
  private state: RunState;
  private abort = new AbortController();
  private task?: Promise<void>;
  private pending = new Map<
    string,
    (result: "approved" | "rejected") => void
  >();
  private issueSequence = 0;
  private nodeTimeoutMs: number;

  constructor(
    workflow: Workflow,
    private runner: NodeRunner,
    options: {
      repairMode?: "confirm" | "automatic";
      id?: string;
      nodeTimeoutMs?: number;
      real: { scope: string[]; baselineVersion: string; workspace: NonNullable<RunState["workspace"]>; allowCommand: (command: CommandSpec) => boolean; allowPath: (path: string) => boolean };
      onChange?: (state: RunState) => void;
    },
  ) {
    const validation = validateWorkflow(workflow);
    if (!validation.valid)
      throw new Error(validation.errors.map((e) => e.message).join("\n"));
    this.onChange = options.onChange;
    this.real = options.real;
    this.nodeTimeoutMs = options.nodeTimeoutMs ?? 600_000;
    this.state = {
      formatVersion: 1,
      id: options.id ?? randomUUID(),
      mode: "real",
      workflow: structuredClone(validation.workflow!),
      scope: options.real.scope,
      repairMode: options.repairMode ?? "confirm",
      applicationStatus: "not_applied",
      status: "pending",
      round: 0,
      maxRounds:
        workflow.nodes.find((n) => n.kind === "loop")?.config.maxRounds ?? 1,
      baselineVersion: options.real.baselineVersion,
      currentVersion: options.real.baselineVersion,
      workspace: structuredClone(options.real.workspace), changes: [], reads: [], commands: [], usage: [],
      records: [],
      issues: [],
      approvals: [],
      events: [],
      createdAt: new Date().toISOString(),
    };
  }
  private onChange?: (state: RunState) => void;
  private real: { allowCommand: (command: CommandSpec) => boolean; allowPath: (path: string) => boolean };
  updateApplication(patch: Pick<RunState, "applicationStatus"> & Partial<Pick<RunState, "transaction" | "applicationError" | "changes">>) {
    Object.assign(this.state, structuredClone(patch));
    if (patch.applicationStatus === "apply_failed" && this.state.conclusion !== "cancelled") {
      if (["passed", "issues_remaining"].includes(this.state.conclusion ?? "")) this.state.reviewConclusion = this.state.conclusion;
      this.state.conclusion = "execution_failed";
      this.state.status = "failed";
      this.state.exitReason = patch.applicationError ?? "文件事务失败，请查看恢复记录";
    }
    if (patch.applicationStatus === "applied" && this.state.reviewConclusion) {
      this.state.conclusion = this.state.reviewConclusion;
      this.state.status = "completed";
      this.state.exitReason = "文件应用重试成功；保留原审查结论与问题";
    }
    if (this.state.status === "awaiting_confirmation" && patch.applicationStatus === "applied") this.state.status = "completed";
    this.emit("application_changed", patch.applicationError ?? `文件状态：${patch.applicationStatus}`);
  }
  captureEvidence(patch: Partial<Pick<RunState, "reads" | "commands" | "usage" | "changes" | "compactions">>) {
    Object.assign(this.state, structuredClone(patch));
    this.emit("evidence_saved", "最终工具证据已保存（包含取消与失败结果）");
  }
  restoreSnapshot(state: RunState) {
    if (this.task || this.state.status !== "pending" || ["pending", "running", "awaiting_approval", "finalizing"].includes(state.status)) throw new Error("只能载入结束或等待确认的历史快照");
    this.state = structuredClone(state);
  }
  finalize(error?: string) {
    if (this.state.status !== "finalizing") return;
    if (error) {
      this.state.status = "failed";
      this.state.conclusion = "execution_failed";
      this.state.exitReason = error;
    } else this.state.status = this.state.applicationStatus === "awaiting_confirmation" ? "awaiting_confirmation" : "completed";
    this.emit("run_finalized", error ?? "最终差异与应用状态已固定");
  }
  snapshot() {
    return structuredClone(this.state);
  }
  private emit(
    type: string,
    message: string,
    nodeId = this.state.currentNodeId,
  ) {
    this.state.events.push({
      seq: this.state.events.length + 1,
      runId: this.state.id,
      time: new Date().toISOString(),
      type,
      message,
      nodeId,
    });
    this.onChange?.(this.snapshot());
  }
  start(): Promise<void> {
    if (!this.task) {
      if (this.state.status !== "pending") return Promise.resolve();
      // Set synchronously, so two starts cannot schedule two executors.
      this.state.status = "running";
      this.task = this.execute();
    }
    return this.task;
  }
  private ensureActive() {
    if (this.abort.signal.aborted || !active.has(this.state.status))
      throw new Error("运行已结束，迟到结果无效");
  }
  cancel() {
    if (!active.has(this.state.status)) return;
    this.abort.abort();
    for (const approval of this.state.approvals)
      if (approval.status === "pending") approval.status = "expired";
    for (const resolve of this.pending.values()) resolve("rejected");
    this.pending.clear();
    const record = this.state.records.at(-1);
    if (
      record &&
      (record.status === "running" || record.status === "awaiting_approval")
    ) {
      record.status = "cancelled";
      record.finishedAt = new Date().toISOString();
    }
    this.finish("cancelled", "用户取消运行", "cancelled");
  }
  interrupt() {
    if (!active.has(this.state.status) && this.state.status !== "finalizing") return;
    if (this.state.status === "finalizing") this.abort.abort();
    else this.cancel();
    this.state.status = "interrupted";
    this.state.conclusion = "execution_failed";
    this.state.exitReason = "后台中断；不自动重放请求";
    this.emit("interrupted", this.state.exitReason);
  }
  expireApprovals(reason: string) {
    if (!this.pending.size) return;
    for (const request of this.state.approvals)
      if (request.status === "pending") request.status = "expired";
    for (const resolve of this.pending.values()) resolve("rejected");
    this.pending.clear();
    this.state.status = "running";
    this.state.records.at(-1)!.status = "running";
    this.emit("approval_expired", reason);
  }
  decideApproval(
    id: string,
    displayHash: string,
    decision: "approved" | "rejected",
  ) {
    const request = this.state.approvals.find((a) => a.id === id);
    if (
      !request ||
      request.status !== "pending" ||
      !this.pending.has(id) ||
      this.state.status !== "awaiting_approval"
    )
      throw new Error("审核已过期或已消费");
    if (
      displayHash !== request.displayHash ||
      request.version !== this.state.currentVersion ||
      request.nodeId !== this.state.currentNodeId ||
      request.round !== this.state.round
    )
      throw new Error("审核内容或版本不匹配");
    request.status = decision;
    request.decidedAt = new Date().toISOString();
    const resolve = this.pending.get(id)!;
    this.pending.delete(id);
    this.state.status = "running";
    this.state.records.at(-1)!.status = "running";
    this.emit(
      "approval_decided",
      decision === "approved"
        ? "已批准本机执行，未启用文件与网络隔离"
        : "已拒绝检查；记录验证未执行",
    );
    resolve(decision);
  }
  private requestApproval = async (
    command: CommandSpec,
  ): Promise<"approved" | "rejected"> => {
    this.ensureActive();
    if (this.pending.size) throw new Error("每个运行只允许一个待审核请求");
    if (!this.real.allowCommand(command)) throw new Error("命令不在本次固定白名单内");
    const signature = (a: CommandSpec) =>
      JSON.stringify([a.executable, a.args, a.cwd]);
    if (
      this.state.approvals.some(
        (a) =>
          a.status === "rejected" &&
          a.version === this.state.currentVersion &&
          signature(a) === signature(command),
      )
    )
      return "rejected";
    const binding = {
      ...structuredClone(command),
      id: randomUUID(),
      runId: this.state.id,
      nodeId: this.state.currentNodeId!,
      round: this.state.round,
      version: this.state.currentVersion,
      environment: "local-minimal-env-v1" as const,
    };
    const request: ApprovalRequest = {
      ...binding,
      displayHash: createHash("sha256")
        .update(JSON.stringify(binding))
        .digest("hex"),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.state.approvals.push(request);
    const promise = new Promise<"approved" | "rejected">((resolve) =>
      this.pending.set(request.id, resolve),
    );
    this.state.status = "awaiting_approval";
    this.state.records.at(-1)!.status = "awaiting_approval";
    this.emit(
      "approval_requested",
      `等待逐次审核：${command.executable} ${JSON.stringify(command.args)}；本机执行，未启用文件与网络隔离`,
    );
    return promise;
  };
  private resolveReference(ref: DataReference): NodeOutput {
    const candidates = this.state.records.filter(
      (record) =>
        record.status === "completed" &&
        record.output &&
        ref.sources.includes(record.nodeId) &&
        record.output.type === ref.output,
    );
    const matching = candidates.filter((r) => {
      const out = r.output!;
      if (!("version" in out)) return false;
      return ref.freshness === "baseline"
        ? out.version === this.state.baselineVersion
        : out.version === this.state.currentVersion &&
            r.round === this.state.round;
    });
    if (!matching.length)
      throw new Error(`输入 ${ref.output} 缺失或版本/轮次过期`);
    return structuredClone(matching.at(-1)!.output!);
  }
  private finish(
    conclusion: Conclusion,
    reason: string,
    status: RunState["status"] = "completed",
  ) {
    this.state.conclusion = conclusion;
    this.state.exitReason = reason;
    this.state.status = status === "completed" ? "finalizing" : status;
    this.state.finishedAt = new Date().toISOString();
    this.state.currentNodeId = undefined;
    for (const node of this.state.workflow.nodes) {
      if (!this.state.records.some((r) => r.nodeId === node.id)) {
        this.state.records.push({
          formatVersion: 1,
          runId: this.state.id,
          id: randomUUID(),
          nodeId: node.id,
          kind: node.kind,
          round: this.state.round,
          inputVersion: this.state.currentVersion,
          startedAt: this.state.finishedAt,
          finishedAt: this.state.finishedAt,
          status: "skipped",
          input: {},
        });
      }
    }
    this.emit("run_finished", reason);
  }
  private latestReview(): ReviewResult | undefined {
    const out = this.state.records.findLast(
      (r) => r.status === "completed" && r.output?.type === "review",
    )?.output;
    return out?.type === "review" ? out : undefined;
  }
  private async runNode(
    node: WorkflowNode,
    input: Record<string, NodeOutput>,
    record: NodeRecord,
  ) {
    const nodeAbort = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, nodeAbort.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error("节点达到耗时预算（含审核等待），停止运行")); nodeAbort.abort(); }, this.nodeTimeoutMs);
    });
    let abortListener!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abortListener = () => reject(new Error("运行已取消"));
      this.abort.signal.addEventListener("abort", abortListener, {
        once: true,
      });
    });
    try {
      return await Promise.race([
        this.runner({
          node: structuredClone(node),
          input: structuredClone(input),
          state: this.snapshot(),
          signal,
          syncVersion: (version) => {
            this.ensureActive();
            if (this.state.currentNodeId !== record.nodeId || record.status !== "running") throw new Error("节点无权更新版本");
            this.state.currentVersion = version;
          },
          update: (patch, message) => {
            this.ensureActive();
            if (this.state.currentNodeId !== record.nodeId || record.status !== "running") throw new Error("节点已结束");
            Object.assign(this.state, structuredClone(patch));
            this.emit("tool_result", message);
          },
          requestApproval: async (command) => {
            this.ensureActive();
            if (
              record.status !== "running" ||
              this.state.currentNodeId !== record.nodeId ||
              this.state.round !== record.round
            )
              throw new Error("工具请求所属节点已结束或过期");
            return this.requestApproval(command);
          },
        }),
        cancelled,
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
      nodeAbort.abort();
      this.abort.signal.removeEventListener("abort", abortListener);
    }
  }
  private acceptReview(raw: unknown, node: WorkflowNode): ReviewResult {
    const review = reviewResultSchema.parse(raw);
    if (review.version !== this.state.currentVersion)
      throw new Error("审查结果版本错误");
    if (
      review.scope.length !== this.state.scope.length ||
      review.scope.some((path) => !this.state.scope.includes(path))
    )
      throw new Error("审查范围与固定快照不一致");
    if (new Set(review.issues.map((i) => i.id)).size !== review.issues.length)
      throw new Error("问题标识重复");
    const old = this.state.issues;
    review.issues = review.issues.map((issue) => {
      if (issue.version !== review.version) throw new Error("问题定位版本错误");
      const existing =
        node.kind === "rereview"
          ? old.find((i) => i.id === issue.id && i.path === issue.path)
          : undefined;
      return { ...issue, id: existing?.id ?? `I-${++this.issueSequence}` };
    });
    if (node.kind === "rereview") {
      for (const issue of old)
        if (!review.issues.some((i) => i.id === issue.id))
          review.issues.push({
            ...issue,
            status: "unconfirmed",
          });
    }
    this.state.issues = structuredClone(review.issues);
    return review;
  }
  private async execute() {
    this.emit(
      "run_started",
      "启动真实工作流；命令需要逐次审核，文件与网络隔离未启用",
    );
    let nodeId = this.state.workflow.nodes.find((n) => n.kind === "read")!.id;
    // Defense in depth: even a future validator regression cannot make execution infinite.
    const stepBudget =
      this.state.workflow.nodes.length * (this.state.maxRounds + 2);
    try {
      for (let step = 0; step < stepBudget; step++) {
        this.ensureActive();
        const node = this.state.workflow.nodes.find((n) => n.id === nodeId)!;
        this.state.currentNodeId = nodeId;
        const input = Object.fromEntries(
          Object.entries(node.inputs).map(([key, ref]) => [
            key,
            this.resolveReference(ref),
          ]),
        );
        if (node.kind === "repair") {
          if (this.state.round >= this.state.maxRounds) {
            this.finish("issues_remaining", "已达到修复轮数上限");
            return;
          }
          this.state.round++;
        }
        const record: NodeRecord = {
          formatVersion: 1,
          runId: this.state.id,
          id: randomUUID(),
          nodeId,
          kind: node.kind,
          round: this.state.round,
          inputVersion: this.state.currentVersion,
          startedAt: new Date().toISOString(),
          status: "running",
          input,
        };
        this.state.records.push(record);
        this.emit("node_started", `${node.label} · 第 ${this.state.round} 轮`);
        let output: NodeOutput;
        let port = "next";
        if (node.kind === "branch") {
          const review = input.review as ReviewResult;
          const facts = reviewFacts(review);
          if (!facts.validationComplete)
            throw new Error("缺失必要验证不能进入条件分支");
          port =
            node.config.conditions.find((c) => matchesCondition(c, facts))
              ?.id ?? "fallback";
          output = { type: "decision", port, reason: `按显式顺序选择 ${port}` };
        } else if (node.kind === "loop") {
          const facts = reviewFacts(input.review as ReviewResult);
          port =
            facts.blockingCount > 0 &&
            facts.validationComplete &&
            this.state.round < node.config.maxRounds
              ? "continue"
              : "exit";
          output = {
            type: "decision",
            port,
            reason:
              port === "continue"
                ? "仍有阻塞问题，进入下一轮"
                : facts.blockingCount === 0
                  ? "没有阻塞问题"
                  : "已达到修复轮数上限",
          };
          if (port === "exit") this.state.exitReason = output.reason;
        } else if (node.kind === "output") {
          const review = this.latestReview();
          if (!review) throw new Error("输出缺少审查结果");
          const facts = reviewFacts(review);
          output = {
            type: "report",
            conclusion: !facts.validationComplete
              ? "validation_incomplete"
              : facts.blockingCount > 0
                ? "issues_remaining"
                : "passed",
          };
        } else {
          const raw = await this.runNode(node, input, record);
          this.ensureActive();
          if (this.pending.size)
            throw new Error("节点仍有待审请求，不能提前提交结果");
          if (node.kind === "read") {
            output = materialSchema.parse(raw);
            if (
              output.version !== this.state.baselineVersion ||
              output.paths.length !== this.state.scope.length ||
              output.paths.some((p) => !this.state.scope.includes(p))
            )
              throw new Error("读取材料与固定快照不一致");
          } else if (node.kind === "repair") {
            output = repairResultSchema.parse(raw);
            if (
              output.basedOnVersion !== record.inputVersion
            )
              throw new Error("修复前置版本或新版本错误");
            if (output.changes.some((c) => !this.real.allowPath(c.path)))
              throw new Error("修复变更超出固定范围");
            if (
              new Set(output.changes.map((c) => c.path)).size !==
              output.changes.length
            )
              throw new Error("修复路径重复");
            if (
              output.resolutions.some(
                (r) => !this.state.issues.some((i) => i.id === r.issueId),
              )
            )
              throw new Error("修复引用了未知问题");
            this.state.currentVersion = output.version;
          } else output = this.acceptReview(raw, node);
        }
        record.output = output;
        record.status = "completed";
        record.finishedAt = new Date().toISOString();
        this.emit("node_completed", `${node.label} 已完成`);
        if (output.type === "review") {
          const required =
            (node.kind === "review" || node.kind === "rereview") &&
            node.config.requireValidation;
          if (!reviewFacts(output, required).validationComplete) {
            this.finish(
              "validation_incomplete",
              "必要验证未完成，停止修复与应用",
            );
            return;
          }
          if (
            output.validations.some((v) => v.required && v.status === "failed")
          ) {
            this.finish("execution_failed", "必要验证执行失败", "failed");
            return;
          }
        }
        if (output.type === "report") {
          this.finish(
            output.conclusion,
            this.state.exitReason ??
              (output.conclusion === "passed"
                ? "所需审查完整，没有阻塞问题"
                : "审查结束，仍有阻塞问题"),
          );
          return;
        }
        const edge = this.state.workflow.edges.find(
          (e) => e.source === nodeId && e.sourcePort === port,
        );
        if (!edge) throw new Error("当前出口缺少连线");
        nodeId = edge.target;
      }
      throw new Error("超过状态机步骤预算");
    } catch (error) {
      if (this.abort.signal.aborted || !active.has(this.state.status)) return;
      const message = error instanceof Error ? error.message : "节点执行失败";
      const record = this.state.records.at(-1);
      if (
        record?.status === "running" ||
        record?.status === "awaiting_approval"
      ) {
        record.status = "failed";
        record.error = message;
        record.finishedAt = new Date().toISOString();
      }
      for (const request of this.state.approvals)
        if (request.status === "pending") request.status = "expired";
      for (const resolve of this.pending.values()) resolve("rejected");
      this.pending.clear();
      this.finish(error instanceof ValidationIncompleteError ? "validation_incomplete" : "execution_failed", message, error instanceof ValidationIncompleteError ? "completed" : "failed");
    }
  }
}
