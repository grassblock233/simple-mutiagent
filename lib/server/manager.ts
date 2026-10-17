import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { WorkflowEngine, type CommandSpec } from "../workflow/engine";
import { workflowSchema, type RunState } from "../workflow/schema";
import { Storage } from "./storage";
import { HttpError } from "./security";
import { WorkspaceRegistry, WorkingCopy } from "../runtime/workspace";
import { availableCommands, redact } from "../runtime/commands";
import { createDeepSeekClient } from "../runtime/deepseek";
import { createAgentRunner, type RuntimeEvidence } from "../runtime/agent";
import { version } from "../runtime/files";
import { Transactions } from "../runtime/transaction";

export const realRequestSchema = z.object({
  mode: z.literal("real"), workflow: workflowSchema, workspaceId: z.string().uuid(),
  selection: z.array(z.object({ path: z.string().min(1).max(500), directory: z.boolean() }).strict()).min(1).max(1000),
  repairMode: z.enum(["confirm", "automatic"]), requestId: z.string().uuid(),
}).strict();
type Entry = {
  owner: string; engine: WorkflowEngine; listeners: Set<(state: RunState) => void>;
  writes: Promise<void>; storageFailed: boolean; copy?: WorkingCopy; operation?: Promise<unknown>;
};
const active = ["pending", "running", "awaiting_approval", "finalizing"];
class RunManager {
  private storage = new Storage();
  readonly workspaces = new WorkspaceRegistry(this.storage.root);
  private transactions = new Transactions(path.join(this.storage.root, "transactions"));
  private initialization?: Promise<void>;
  private runs = new Map<string, Entry>();
  private requests = new Map<string, { hash: string; task: Promise<RunState> }>();
  private starting = new Set<string>();
  private workspaceStarting = new Set<string>();
  private persist(entry: Entry, raw: RunState) {
    const state: RunState = JSON.parse(redact(JSON.stringify(raw)));
    entry.writes = entry.writes.then(async () => {
      await this.storage.saveRun(state);
      for (const listener of entry.listeners) try { listener(state); } catch { /* disconnected */ }
    }).catch(() => {
      if (!entry.storageFailed) { entry.storageFailed = true; entry.engine.interrupt(); }
    });
  }
  async ready() {
    await (this.initialization ??= Promise.all([this.storage.markInterrupted(), this.transactions.markInterrupted()]).then(() => {}));
  }
  async create(value: unknown, owner: string): Promise<RunState> {
    await this.ready();
    const parsed = realRequestSchema.safeParse(value);
    if (!parsed.success) throw new HttpError(400, "运行配置无效");
    const input = parsed.data;
    const key = `${owner}:${input.requestId}`;
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const old = this.requests.get(key);
    if (old) {
      if (old.hash !== hash) throw new HttpError(409, "幂等标识已绑定其他配置");
      const state = await old.task;
      return this.snapshot(state.id, owner);
    }
    const task = this.start(input, owner);
    this.requests.set(key, { hash, task });
    try { return await task; } catch (error) { this.requests.delete(key); throw error; }
  }
  private async start(input: z.infer<typeof realRequestSchema>, owner: string) {
    if (this.starting.has(owner) || [...this.runs.values()].some(e => e.owner === owner && active.includes(e.engine.snapshot().status))) throw new HttpError(409, "请先结束当前运行");
    if (this.runs.size >= 50) throw new HttpError(429, "本进程最多保留 50 次运行，请保存报告后重启服务");
    this.starting.add(owner);
    let workspaceRoot: string | undefined;
    try {
      const id = randomUUID();
      const entry: Entry = { owner, engine: undefined!, listeners: new Set(), writes: Promise.resolve(), storageFailed: false };
      if (!process.env.DEEPSEEK_API_KEY) throw new HttpError(400, "请先在后台配置 DEEPSEEK_API_KEY");
      const workspace = this.workspaces.get(input.workspaceId, owner);
      workspaceRoot = workspace.root;
      if (this.workspaceStarting.has(workspace.root) || [...this.runs.values()].some(e => e.copy?.workspace.root === workspace.root && active.includes(e.engine.snapshot().status))) throw new HttpError(409, "同一工作区已有活动运行");
      this.workspaceStarting.add(workspace.root);
      const parent = path.join(this.storage.root, "copies");
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const copy = await WorkingCopy.create(workspace, input.selection, path.join(parent, id));
      entry.copy = copy;
      await this.storage.saveBaseline(id, copy.baseline);
      const commands = await availableCommands(copy);
      const evidence: RuntimeEvidence = { reads: [], commands: [], usage: [] };
      const runner = createAgentRunner(copy, commands, createDeepSeekClient({ apiKey: process.env.DEEPSEEK_API_KEY, onUncertain: usage => evidence.usage.push(usage) }), evidence);
      const real = { scope: copy.scope(), baselineVersion: version(copy.baseline), workspace: { id: workspace.id, root: workspace.root, selection: copy.selection, excludes: workspace.excludes }, allowPath: (p: string) => copy.canWrite(p), allowCommand: (c: CommandSpec) => c.cwd === copy.root && commands.some(a => a.executable === c.executable && JSON.stringify(a.args) === JSON.stringify(c.args)) };
      entry.engine = new WorkflowEngine(input.workflow, runner, {
        id, real, repairMode: input.repairMode,
        onChange: raw => this.persist(entry, raw),
      });
      await this.storage.saveRun(entry.engine.snapshot());
      this.runs.set(id, entry);
      void entry.engine.start().then(async () => {
        if (!entry.copy) return;
        try {
          await evidence.pending;
          entry.engine.captureEvidence({ reads: evidence.reads, commands: evidence.commands, usage: evidence.usage });
          const changes = await entry.copy.changes();
          entry.engine.updateApplication({ applicationStatus: "not_applied", changes });
          const state = entry.engine.snapshot();
          if (state.status !== "finalizing") return;
          await entry.copy.checkedChanges();
          if (["passed", "issues_remaining"].includes(state.conclusion ?? "") && changes.length) {
            if (state.repairMode === "automatic") await this.apply(id, owner, state.currentVersion, true);
            else entry.engine.updateApplication({ applicationStatus: "awaiting_confirmation", changes });
          }
          entry.engine.finalize();
          await entry.writes;
          const final = entry.engine.snapshot();
          if (["completed"].includes(final.status) && ["applied", "not_applied", "undone"].includes(final.applicationStatus)) await rm(entry.copy.root, { recursive: true, force: true });
        } catch (error) {
          const message = redact(error instanceof Error ? error.message : "整理文件差异失败");
          entry.engine.updateApplication({ applicationStatus: "apply_failed", applicationError: message });
          entry.engine.finalize(message);
        }
      });
      return this.snapshot(id, owner);
    } finally {
      this.starting.delete(owner);
      if (workspaceRoot) this.workspaceStarting.delete(workspaceRoot);
    }
  }
  async apply(id: string, owner: string, expectedVersion: string, automatic = false) {
    const entry = this.get(id, owner);
    const state = entry.engine.snapshot();
    if (expectedVersion !== state.currentVersion) throw new HttpError(409, "差异版本已变化");
    if (entry.operation) throw new HttpError(409, "文件事务正在进行");
    if (state.applicationStatus === "applied") {
      if (expectedVersion !== state.currentVersion) throw new HttpError(409, "差异版本已变化");
      return this.snapshot(id, owner);
    }
    if (!entry.copy || entry.storageFailed || !(automatic ? ["finalizing"] : ["completed", "awaiting_confirmation", "failed"]).includes(state.status) || !["passed", "issues_remaining"].includes(state.reviewConclusion ?? state.conclusion ?? "") || state.applicationStatus === "undone") throw new HttpError(409, "运行不满足应用条件");
    entry.operation = (async () => {
      try {
        await entry.writes;
        if (entry.storageFailed) throw new Error("运行记录持久化失败，禁止文件应用");
        const transaction = await this.transactions.apply(entry.copy!, id, expectedVersion);
        entry.engine.updateApplication({ applicationStatus: transaction.status === "applied" ? "applied" : "apply_failed", transaction, applicationError: transaction.error });
        if (transaction.status !== "applied") entry.engine.finalize(transaction.error ?? "应用事务未完成");
        await entry.writes;
        if (!automatic && transaction.status === "applied") await rm(entry.copy!.root, { recursive: true, force: true });
        return this.snapshot(id, owner);
      } catch (error) {
        entry.engine.updateApplication({ applicationStatus: "apply_failed", applicationError: redact(error instanceof Error ? error.message : "应用失败") });
        await entry.writes;
        throw new HttpError(409, "应用冲突或事务失败，请查看运行明细");
      } finally { entry.operation = undefined; }
    })();
    return entry.operation;
  }
  async undo(id: string, owner: string) {
    const entry = this.get(id, owner);
    if (entry.operation) throw new HttpError(409, "文件事务正在进行");
    const state = entry.engine.snapshot();
    if (state.applicationStatus === "undone") return this.snapshot(id, owner);
    if (!state.transaction || state.applicationStatus !== "applied") throw new HttpError(409, "没有可撤销的应用");
    entry.operation = (async () => {
      try {
        const transaction = await this.transactions.undo(state.transaction!.id, id);
        entry.engine.updateApplication({ applicationStatus: transaction.status === "undone" ? "undone" : "apply_failed", transaction, applicationError: transaction.error });
        await entry.writes;
        return this.snapshot(id, owner);
      } catch { throw new HttpError(409, "撤销冲突，整批停止；不会覆盖后续编辑"); }
      finally { entry.operation = undefined; }
    })();
    return entry.operation;
  }
  get(id: string, owner: string): Entry {
    const entry = this.runs.get(id);
    if (!entry || entry.owner !== owner) throw new HttpError(404, "运行不存在或不属于当前会话");
    return entry;
  }
  async history(owner: string) {
    await this.ready();
    const states = await this.storage.listRuns();
    return states.filter(s => !this.runs.has(s.id) || this.runs.get(s.id)!.owner === owner).map(s => ({ id: s.id, name: s.workflow.name, mode: s.mode, createdAt: s.createdAt, status: s.status, conclusion: s.conclusion, applicationStatus: s.applicationStatus, workspace: s.workspace?.root, recoverable: !["pending", "running", "awaiting_approval", "finalizing"].includes(s.status) }));
  }
  async restore(id: string, owner: string) {
    await this.ready();
    if (this.runs.has(id)) return this.snapshot(id, owner);
    if (this.runs.size >= 50) throw new HttpError(429, "请先删除不再需要的历史或重启服务");
    let state: RunState;
    try { state = await this.storage.loadRun(id); } catch { throw new HttpError(404, "历史记录不存在或格式无效"); }
    const entry: Entry = { owner, engine: undefined!, listeners: new Set(), writes: Promise.resolve(), storageFailed: false };
    if (state.workspace) {
      const workspace = { ...state.workspace, files: state.scope };
      this.workspaces.restore(workspace, owner);
      if (state.applicationStatus === "awaiting_confirmation" || (state.applicationStatus === "apply_failed" && state.reviewConclusion)) {
        try { entry.copy = await WorkingCopy.restore(workspace, state.workspace.selection, await this.storage.loadBaseline(id), path.join(this.storage.root, "copies", id)); }
        catch { state.reviewConclusion ??= state.conclusion; state.conclusion = "execution_failed"; state.status = "failed"; state.applicationStatus = "apply_failed"; state.applicationError = "历史副本或原工作区不可访问；请重新运行，不自动重放"; }
      }
    }
    const historicalTransaction = await this.transactions.findRun(state.id);
    if (historicalTransaction) {
      const transaction = historicalTransaction;
      state.transaction = transaction;
      state.applicationStatus = transaction.status === "applied" ? "applied" : transaction.status === "undone" ? "undone" : "apply_failed";
      if (transaction.status === "needs_recovery") state.applicationError = transaction.error;
      if (state.applicationStatus === "apply_failed") { state.reviewConclusion ??= state.conclusion; state.conclusion = "execution_failed"; state.status = "failed"; }
    }
    entry.engine = new WorkflowEngine(state.workflow, async () => { throw new Error("历史运行禁止自动重放"); }, { real: { scope: state.scope, baselineVersion: state.baselineVersion, workspace: state.workspace!, allowPath: () => false, allowCommand: () => false }, onChange: raw => this.persist(entry, raw) });
    entry.engine.restoreSnapshot(state);
    this.runs.set(id, entry);
    return this.snapshot(id, owner);
  }
  async remove(id: string, owner: string) {
    await this.ready();
    const entry = this.runs.has(id) ? this.get(id, owner) : undefined;
    let state: RunState;
    try { state = entry ? entry.engine.snapshot() : await this.storage.loadRun(id); }
    catch { throw new HttpError(404, "历史记录不存在或格式无效"); }
    if (active.includes(state.status) || entry?.operation) throw new HttpError(409, "请先结束运行或文件事务");
    if (state.transaction?.status === "needs_recovery") throw new HttpError(409, "未解决恢复事务不能删除，请先人工处理备份");
    if (entry) await entry.writes;
    await this.transactions.removeRun(id);
    await this.storage.removeRun(id);
    this.runs.delete(id);
    // Retain successful create request ids as tombstones: replay must not recreate side effects.
  }
  snapshot(id: string, owner: string): RunState { return JSON.parse(redact(JSON.stringify(this.get(id, owner).engine.snapshot()))); }
}
const globalManager = globalThis as typeof globalThis & { simpleWorkflowManager?: RunManager };
export const manager = (globalManager.simpleWorkflowManager ??= new RunManager());
