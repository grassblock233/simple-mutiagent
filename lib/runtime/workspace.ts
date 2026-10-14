import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, lstat, chmod } from "node:fs/promises";
import path from "node:path";
import { SafeRoot, allowed, DEFAULT_EXCLUDES, differences, scan, version, within, relative, LIMITS, type Manifest, type Selection, type Change } from "./files";

export type Workspace = { id: string; root: string; excludes: string[]; files: string[] };
export class WorkspaceRegistry {
  private entries = new Map<string, { owner: string; workspace: Workspace }>();
  constructor(readonly dataRoot: string) {}
  async browse(directory: string) {
    const root = await realpath(directory);
    const items = await readdir(root, { withFileTypes: true });
    return { root, parent: path.dirname(root), directories: items.filter(i => i.isDirectory() && !i.isSymbolicLink() && !i.name.startsWith(".")).slice(0, 500).map(i => ({ name: i.name, path: path.join(root, i.name) })) };
  }
  async open(directory: string, owner: string, excludes = DEFAULT_EXCLUDES): Promise<Workspace> {
    const root = await realpath(directory);
    await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    const data = await realpath(this.dataRoot);
    if (within(root, data) || within(data, root)) throw new Error("工作区与运行数据目录必须分离且不能互相包含");
    if (!(await lstat(root)).isDirectory()) throw new Error("请选择目录");
    if (this.entries.size >= 100) throw new Error("工作区数量超过限制，请重启服务");
    const effectiveExcludes = [...new Set([...excludes, "node_modules/", ".workflow-home/", ".workflow-tmp/"])];
    const manifest = await scan(root, effectiveExcludes);
    const workspace = { id: randomUUID(), root, excludes: effectiveExcludes, files: Object.keys(manifest).sort() };
    this.entries.set(workspace.id, { owner, workspace });
    return structuredClone(workspace);
  }
  get(id: string, owner: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) throw new Error("工作区不存在或不属于当前会话");
    return structuredClone(entry.workspace);
  }
  restore(workspace: Workspace, owner: string) { this.entries.set(workspace.id, { workspace: structuredClone(workspace), owner }); }
}

export class WorkingCopy {
  private constructor(
    readonly workspace: Workspace,
    readonly root: string,
    readonly selection: Selection[],
    readonly baseline: Manifest,
    readonly original: SafeRoot,
    readonly safe: SafeRoot,
  ) {}
  static async create(workspace: Workspace, selection: Selection[], directory: string) {
    if (!selection.length) throw new Error("审查范围不能为空");
    const original = await new SafeRoot(workspace.root).initialize();
    const baseline = await scan(workspace.root, workspace.excludes);
    for (const selected of selection) {
      relative(selected.path);
      if (!Object.keys(baseline).some(p => allowed(p, [selected], workspace.excludes))) throw new Error(`勾选项没有可访问文本文件：${selected.path}`);
      const pinned = await original.parent(selected.path);
      try {
        const info = await lstat(pinned.filename);
        if (info.isSymbolicLink() || (selected.directory ? !info.isDirectory() : !info.isFile())) throw new Error("勾选项类型已变化");
      } finally { await pinned.directory.close(); }
    }
    await mkdir(directory, { recursive: false, mode: 0o700 });
    await chmod(directory, 0o700);
    const safe = await new SafeRoot(directory).initialize();
    for (const [file, content] of Object.entries(baseline)) await safe.write(file, null, content, await original.mode(file));
    // Copy only inspected ordinary text files. Dependencies are never followed through links.
    if (version(await scan(workspace.root, workspace.excludes)) !== version(baseline)) throw new Error("创建副本期间工作区发生变化，请重试");
    return new WorkingCopy(workspace, directory, structuredClone(selection), baseline, original, safe);
  }
  static async restore(workspace: Workspace, selection: Selection[], baseline: Manifest, directory: string) {
    return new WorkingCopy(workspace, directory, selection, baseline, await new SafeRoot(workspace.root).initialize(), await new SafeRoot(directory).initialize());
  }
  scope() { return Object.keys(this.baseline).filter(p => this.canWrite(p)).sort(); }
  canWrite(file: string) { return allowed(file, this.selection, this.workspace.excludes); }
  async manifest() { return scan(this.root, this.workspace.excludes, true); }
  async currentVersion() { return version(await this.manifest()); }
  async assertVersion(expected: string) {
    if (await this.currentVersion() !== expected) throw new Error("副本版本冲突，请重新读取当前版本");
  }
  async read(file: string, expected: string, startLine = 1, endLine = startLine + 199) {
    relative(file);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) throw new Error("行范围无效");
    if (await this.currentVersion() !== expected) throw new Error("读取版本已过期");
    const manifest = await this.manifest();
    if (!(file in manifest)) throw new Error("文件不存在、已排除或不可读取");
    const lines = manifest[file].split("\n");
    const content = lines.slice(startLine - 1, endLine).join("\n");
    if (Buffer.byteLength(content) > LIMITS.readBytes) throw new Error("读取超过 256 KiB，请缩小行范围");
    return { path: file, version: expected, startLine, endLine: Math.min(endLine, lines.length), totalLines: lines.length, content };
  }
  async patch(file: string, before: string | null, after: string | null, expected: string) {
    await this.assertVersion(expected);
    if (!this.canWrite(file)) throw new Error("补丁超出修改范围或命中排除规则");
    if (after !== null && (Buffer.byteLength(after) > LIMITS.fileBytes || after.includes("\0"))) throw new Error("补丁不是允许大小的文本");
    await this.safe.write(file, before, after);
    return this.currentVersion();
  }
  async changes(): Promise<Change[]> { return differences(this.baseline, await this.manifest()); }
  async checkedChanges() {
    const changes = await this.changes();
    if (changes.some(c => !this.canWrite(c.path))) throw new Error("副本存在范围外源码变化，禁止整批应用");
    return changes;
  }
  async checkBaseline() {
    // Check all copied sources, including unselected context, plus additions/removals.
    const current = await scan(this.workspace.root, this.workspace.excludes);
    if (version(current) !== version(this.baseline)) throw new Error("原工作区基线冲突，停止整批应用");
  }
}
