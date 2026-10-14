import { mkdir, rename, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SafeRoot, type Change } from "./files";
import { type WorkingCopy } from "./workspace";

export type Transaction = {
  formatVersion: 1; id: string; runId: string; root: string; changes: Change[];
  status: "prepared" | "applying" | "applied" | "rolling_back" | "rolled_back" | "undoing" | "undone" | "needs_recovery";
  processed: string[]; recovered: string[]; createdAt: string; error?: string;
  modes?: Record<string, number>;
};
const locks = new Set<string>();
export async function withWorkspaceLock<T>(root: string, action: () => Promise<T>) {
  if (locks.has(root)) throw new Error("工作区文件事务正在进行");
  locks.add(root);
  try { return await action(); } finally { locks.delete(root); }
}
export class Transactions {
  constructor(readonly directory: string, private fault?: (stage: string, file: string) => void) {}
  private async save(record: Transaction) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, `${record.id}.json`);
    const temp = `${target}.${randomUUID()}.tmp`;
    // The durable record itself is the original-content backup. Persist before any write.
    const { open } = await import("node:fs/promises");
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, target);
    const dir = await open(this.directory, "r");
    try { await dir.sync(); } finally { await dir.close(); }
  }
  async load(id: string): Promise<Transaction> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("无效事务标识");
    return JSON.parse(await readFile(path.join(this.directory, `${id}.json`), "utf8"));
  }
  async markInterrupted() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const filename of await readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(filename)) continue;
      const record = await this.load(filename.slice(0, -5));
      if (["prepared", "applying", "rolling_back", "undoing"].includes(record.status)) {
        record.status = "needs_recovery";
        record.error = "后台中断，禁止自动重放；检查 processed 与目标内容后人工恢复";
        await this.save(record);
      }
    }
  }
  async forRun(runId: string) {
    let filenames: string[];
    try { filenames = await readdir(this.directory); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    const matches: Transaction[] = [];
    for (const file of filenames.filter(f => /^[a-f0-9-]{36}\.json$/.test(f))) {
      const record = await this.load(file.slice(0, -5));
      if (record.runId === runId) matches.push(record);
    }
    return matches.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }
  async findRun(runId: string) { return (await this.forRun(runId))[0]; }
  async removeRun(runId: string) {
    const records = await this.forRun(runId);
    if (records.some(r => ["prepared", "applying", "rolling_back", "undoing", "needs_recovery"].includes(r.status))) throw new Error("未解决恢复事务不能删除，请先人工处理备份");
    for (const record of records) await rm(path.join(this.directory, `${record.id}.json`), { force: true });
  }
  private async assertNoRecovery(root: string) {
    let filenames: string[];
    try { filenames = await readdir(this.directory); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    for (const file of filenames.filter(f => /^[a-f0-9-]{36}\.json$/.test(f))) {
      const record = await this.load(file.slice(0, -5));
      if (record.root === root && ["prepared", "applying", "rolling_back", "undoing", "needs_recovery"].includes(record.status)) throw new Error("工作区存在未解决文件事务，请先按备份和日志人工恢复");
    }
  }
  async apply(copy: WorkingCopy, runId: string, expectedVersion: string): Promise<Transaction> {
    return withWorkspaceLock(copy.workspace.root, async () => {
      await this.assertNoRecovery(copy.workspace.root);
      await copy.assertVersion(expectedVersion);
      await copy.checkBaseline();
      const changes = await copy.checkedChanges();
      if (!changes.length) throw new Error("没有可应用的差异");
      // Preflight every path before creating backups or changing any source.
      for (const c of changes) if (await copy.original.read(c.path) !== c.before) throw new Error(`整批冲突：${c.path}`);
      const record: Transaction = { formatVersion: 1, id: randomUUID(), runId, root: copy.workspace.root, changes, status: "prepared", processed: [], recovered: [], createdAt: new Date().toISOString() };
      record.modes = Object.create(null);
      for (const c of changes) if (c.before !== null) record.modes![c.path] = await copy.original.mode(c.path);
      await this.save(record);
      record.status = "applying";
      await this.save(record);
      try {
        for (const c of changes) {
          this.fault?.("apply", c.path);
          await copy.original.write(c.path, c.before, c.after);
          record.processed.push(c.path);
          await this.save(record);
        }
        record.status = "applied";
        await this.save(record);
        return record;
      } catch (error) {
        record.error = error instanceof Error ? error.message : "应用失败";
        record.status = "rolling_back";
        await this.save(record);
        for (const file of [...record.processed].reverse()) {
          const c = changes.find(c => c.path === file)!;
          try { await copy.original.write(file, c.after, c.before, record.modes?.[file]); record.recovered.push(file); await this.save(record); }
          catch { record.status = "needs_recovery"; }
        }
        if (record.status !== "needs_recovery") record.status = "rolled_back";
        await this.save(record);
        return record;
      }
    });
  }
  async undo(id: string, runId: string): Promise<Transaction> {
    const record = await this.load(id);
    if (record.runId !== runId) throw new Error("事务不属于当前运行");
    if (record.status === "undone") return record;
    if (record.status !== "applied") throw new Error("事务未完整应用，不能普通撤销；请检查恢复记录");
    return withWorkspaceLock(record.root, async () => {
      const safe = await new SafeRoot(record.root).initialize();
      for (const c of record.changes) if (await safe.read(c.path) !== c.after) throw new Error(`撤销冲突：${c.path}，整批停止`);
      record.status = "undoing"; record.processed = []; record.recovered = [];
      await this.save(record);
      try {
        for (const c of [...record.changes].reverse()) {
          this.fault?.("undo", c.path);
          await safe.write(c.path, c.after, c.before, record.modes?.[c.path]);
          record.processed.push(c.path);
          await this.save(record);
        }
        record.status = "undone";
      } catch (error) {
        record.status = "needs_recovery";
        record.error = error instanceof Error ? error.message : "部分撤销失败";
      }
      await this.save(record);
      return record;
    });
  }
}
