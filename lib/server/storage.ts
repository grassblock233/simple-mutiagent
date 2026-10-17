import {
  mkdir,
  readFile,
  rename,
  writeFile,
  chmod,
  readdir,
  rm,
  open,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { type RunState, type Workflow } from "../workflow/schema";
import { validateWorkflow } from "../workflow/validate";
import { markdownReport } from "../workflow/report";
import type { Manifest } from "../runtime/files";

export class Storage {
  constructor(
    readonly root = process.env.SIMPLE_WORKFLOW_DATA_DIR ||
      path.join(homedir(), ".local", "share", "simple-mutiagent"),
  ) {}
  private async atomic(filename: string, value: unknown, raw = false) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(filename), 0o700);
    const temp = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temp, raw ? String(value) : JSON.stringify(value, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    const handle = await open(temp, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temp, filename);
  }
  async saveWorkflow(workflow: Workflow) {
    await this.atomic(path.join(this.root, "workflow.json"), workflow);
  }
  async loadWorkflow(): Promise<Workflow | null> {
    try {
      const result = validateWorkflow(
        JSON.parse(
          await readFile(path.join(this.root, "workflow.json"), "utf8"),
        ),
      );
      if (!result.valid) throw new Error("已保存工作流格式或语义无效");
      return result.workflow!;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async saveRun(state: RunState) {
    if (!/^[a-f0-9-]{36}$/.test(state.id)) throw new Error("无效运行标识");
    await this.atomic(path.join(this.root, "runs", `${state.id}.json`), state);
    await this.atomic(path.join(this.root, "events", `${state.id}.jsonl`), state.events.map(e => JSON.stringify(e)).join("\n") + "\n", true);
    if (!["pending", "running", "awaiting_approval", "finalizing"].includes(state.status)) {
      await this.atomic(path.join(this.root, "reports", `${state.id}.md`), markdownReport(state), true);
      await this.atomic(path.join(this.root, "diffs", `${state.id}.json`), { version: state.currentVersion, changes: state.changes ?? [] });
    }
  }
  async saveBaseline(id: string, baseline: Manifest) {
    this.checkId(id);
    await this.atomic(path.join(this.root, "baselines", `${id}.json`), baseline);
  }
  async loadBaseline(id: string): Promise<Manifest> {
    this.checkId(id);
    return JSON.parse(await readFile(path.join(this.root, "baselines", `${id}.json`), "utf8"));
  }
  private checkId(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("无效运行标识"); }
  async loadRun(id: string): Promise<RunState> {
    this.checkId(id);
    const state: RunState = JSON.parse(await readFile(path.join(this.root, "runs", `${id}.json`), "utf8"));
    if (state.mode !== "real" || !state.workspace || state.id !== id || state.formatVersion !== 1 || !validateWorkflow(state.workflow).valid) throw new Error("历史格式无效");
    return state;
  }
  async listRuns() {
    let files: string[];
    try { files = await readdir(path.join(this.root, "runs")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const states: RunState[] = [];
    for (const file of files.filter(f => /^[a-f0-9-]{36}\.json$/.test(f))) {
      const raw = JSON.parse(await readFile(path.join(this.root, "runs", file), "utf8"));
      if (raw.mode === "real") states.push(await this.loadRun(file.slice(0, -5)));
    }
    return states.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async removeRun(id: string, transactionId?: string) {
    this.checkId(id);
    if (transactionId) this.checkId(transactionId);
    for (const directory of ["runs", "events", "reports", "diffs", "baselines"]) {
      const extension = directory === "events" ? "jsonl" : directory === "reports" ? "md" : "json";
      await rm(path.join(/* turbopackIgnore: true */ this.root, directory, `${id}.${extension}`), { force: true });
    }
    await rm(path.join(this.root, "copies", id), { recursive: true, force: true });
    if (transactionId) await rm(path.join(this.root, "transactions", `${transactionId}.json`), { force: true });
  }
  async markInterrupted() {
    const directory = path.join(this.root, "runs");
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const file of files.filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))) {
      const state: RunState = JSON.parse(
        await readFile(path.join(directory, file), "utf8"),
      );
      if (state.mode !== "real") continue;
      if (["pending", "running", "awaiting_approval", "finalizing"].includes(state.status)) {
        state.status = "interrupted";
        state.conclusion = "execution_failed";
        state.exitReason = "后台重启，未完成运行已中断，不自动重放";
        state.finishedAt = new Date().toISOString();
        state.currentNodeId = undefined;
        state.approvals.forEach((a) => {
          if (a.status === "pending") a.status = "expired";
        });
        state.records.forEach((r) => {
          if (r.status === "running" || r.status === "awaiting_approval") {
            r.status = "failed";
            r.error = state.exitReason;
            r.finishedAt = state.finishedAt;
          }
        });
        state.events.push({
          seq: state.events.length + 1,
          runId: state.id,
          type: "interrupted",
          time: state.finishedAt,
          message: state.exitReason,
        });
        await this.saveRun(state);
      }
    }
  }
}
