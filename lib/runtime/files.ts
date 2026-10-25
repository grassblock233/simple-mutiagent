import { constants } from "node:fs";
import { open, lstat, realpath, readdir, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { type ScanStats } from "../workspace-rules";
export { DEFAULT_EXCLUDES } from "../workspace-rules";
export const LIMITS = { fileBytes: 1024 * 1024, readBytes: 256 * 1024 };
export type Change = { path: string; before: string | null; after: string | null };
export type Selection = { path: string; directory: boolean };
export type Manifest = Record<string, string>;
export function relative(value: string) {
  if (!value || value.length > 500 || value.includes("\0") || value.includes("\\") || path.isAbsolute(value) || value.split("/").some(p => !p || p === "." || p === "..")) throw new Error("路径必须是工作区内的规范相对路径");
  return value;
}
export function within(root: string, target: string) { return target === root || target.startsWith(root + path.sep); }
export function excluded(file: string, rules: string[]) {
  return rules.some(rule => {
    const directory = rule.endsWith("/");
    const source = rule.replace(/\/$/, "");
    let pattern = "";
    for (let i = 0; i < source.length; i++) {
      if (source[i] === "*" && source[i + 1] === "*") { pattern += ".*"; i++; }
      else if (source[i] === "*") pattern += "[^/]*";
      else pattern += source[i].replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
    const expression = new RegExp(`^${pattern}${directory ? "(?:/|$)" : "$"}`);
    return (source.includes("/") ? [file] : file.split("/")).some(p => expression.test(p));
  });
}
export function allowed(file: string, selection: Selection[], rules: string[]) {
  relative(file);
  return !excluded(file, rules) && selection.some(s => file === s.path || (s.directory && file.startsWith(s.path + "/")));
}
export function version(files: Manifest) {
  return createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
}
export function differences(before: Manifest, after: Manifest): Change[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(p => before[p] !== after[p]).map(p => ({ path: p, before: before[p] ?? null, after: after[p] ?? null }));
}
export function text(buffer: Buffer) {
  if (buffer.includes(0)) throw new Error("拒绝二进制文件");
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

// Linux dirfd anchoring: every directory is opened without following symlinks.
// All final IO uses the pinned parent fd, so a swapped parent cannot redirect writes.
export class SafeRoot {
  private identity?: string;
  constructor(readonly root: string) {}
  async initialize() {
    if (process.platform !== "linux") throw new Error("真实文件操作当前仅支持 Linux");
    if (await realpath(this.root) !== this.root) throw new Error("工作区根路径必须已规范化");
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("无效工作区根目录");
    this.identity = `${stat.dev}:${stat.ino}`;
    return this;
  }
  async parent(file: string, create = false) {
    const parts = relative(file).split("/");
    let directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const st = await directory.stat();
      if (this.identity && `${st.dev}:${st.ino}` !== this.identity) throw new Error("工作区根目录已替换");
      for (const part of parts.slice(0, -1)) {
        const nextPath = `/proc/self/fd/${directory.fd}/${part}`;
        if (create) await mkdir(nextPath, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
        const next = await open(nextPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await directory.close(); directory = next;
      }
      const physical = await realpath(`/proc/self/fd/${directory.fd}`);
      if (!within(this.root, physical)) throw new Error("父目录已移出工作区");
      return { directory, filename: `/proc/self/fd/${directory.fd}/${parts.at(-1)}` };
    } catch (e) { await directory.close(); throw e; }
  }
  async read(file: string): Promise<string | null> {
    let parent;
    try { parent = await this.parent(file); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    try {
      let handle;
      try { handle = await open(parent.filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
      try {
        const st = await handle.stat();
        if (!st.isFile() || st.nlink !== 1 || st.size > LIMITS.fileBytes) throw new Error("拒绝特殊、硬链接或超限文件");
        const buffer = Buffer.alloc(Math.min(st.size + 1, LIMITS.fileBytes + 1));
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
          if (!chunk.bytesRead) break;
          bytesRead += chunk.bytesRead;
        }
        if (bytesRead > LIMITS.fileBytes) throw new Error("文件读取超限");
        const after = await handle.stat();
        if (bytesRead !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs) throw new Error("读取期间文件发生变化，请重试");
        return text(buffer.subarray(0, bytesRead));
      } finally { await handle.close(); }
    } finally { await parent.directory.close(); }
  }
  async mode(file: string) {
    const parent = await this.parent(file);
    try {
      const stat = await lstat(parent.filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("文件类型无效");
      return stat.mode & 0o777;
    } finally { await parent.directory.close(); }
  }
  async write(file: string, expected: string | null, target: string | null, newMode = 0o644) {
    if (await this.read(file) !== expected) throw new Error(`文件冲突：${file}`);
    const parent = await this.parent(file, target !== null);
    const temporary = `/proc/self/fd/${parent.directory.fd}/.workflow-${randomUUID()}.tmp`;
    try {
      const current = await this.read(file);
      if (current !== expected) throw new Error(`文件冲突：${file}`);
      if (target === null) { if (expected !== null) { await unlink(parent.filename); await parent.directory.sync(); } return; }
      let mode = newMode & 0o777;
      if (expected !== null) {
        const stat = await lstat(parent.filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("文件类型已变化");
        mode = stat.mode & 0o777;
      }
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
      try { await handle.chmod(mode); await handle.writeFile(target); await handle.sync(); } finally { await handle.close(); }
      if (await this.read(file) !== expected) throw new Error(`文件冲突：${file}`);
      if (!within(this.root, await realpath(`/proc/self/fd/${parent.directory.fd}`))) throw new Error("父目录已移出工作区");
      await rename(temporary, parent.filename);
      await parent.directory.sync();
    } finally {
      await unlink(temporary).catch(() => {});
      await parent.directory.close();
    }
  }
}
export type ScanOptions = { signal?: AbortSignal; onProgress?: (stats: ScanStats) => void };
async function walkFiles(root: string, rules: string[], strict: boolean, collect: (file: string, content: string) => void, options: ScanOptions) {
  const safe = await new SafeRoot(root).initialize();
  const stats: ScanStats = { scanned: 0, files: 0, bytes: 0, skipped: {}, directories: [] };
  const directories = new Map<string, { path: string; files: number; bytes: number }>();
  let last = 0;
  const progress = (force = false) => {
    if (force || Date.now() - last >= 100) {
      last = Date.now();
      stats.directories = [...directories.values()].sort((a,b) => b.bytes-a.bytes).slice(0, 8);
      options.onProgress?.(structuredClone(stats));
    }
  };
  const skip = (reason: string) => { stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1; };
  async function walk(directory: string) {
    options.signal?.throwIfAborted();
    for (const item of await readdir(directory, { withFileTypes: true })) {
      options.signal?.throwIfAborted(); stats.scanned++;
      const p = path.relative(root, path.join(directory, item.name)).split(path.sep).join("/");
      if (excluded(p, rules)) { skip("排除规则"); progress(); continue; }
      if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) {
        if (strict) throw new Error("副本包含符号链接或特殊文件：" + p);
        skip("链接或特殊文件"); progress(); continue;
      }
      if (item.isDirectory()) {
        const physical = await realpath(path.join(root, p));
        if (!within(root, physical) || (await lstat(path.join(root, p))).isSymbolicLink()) throw new Error("扫描路径已变化");
        await walk(path.join(root, p));
      } else {
        try {
          const content = await safe.read(p); options.signal?.throwIfAborted();
          if (content === null) throw new Error("扫描期间文件消失");
          collect(p, content); const size = Buffer.byteLength(content);
          stats.files++; stats.bytes += size;
          const parts = p.split("/");
          const key = parts.length > 1 ? parts[0] + "/" : "（根目录文件）";
          const d = directories.get(key) ?? { path: key, files: 0, bytes: 0 };
          d.files++; d.bytes += size; directories.set(key, d);
        } catch (e) {
          options.signal?.throwIfAborted(); if (strict) throw e;
          skip(e instanceof Error && /超限/.test(e.message) ? "超过 1 MiB 或非普通文件" : "二进制、非 UTF-8 或不可读");
        }
        progress();
      }
    }
  }
  progress(true); await walk(root); options.signal?.throwIfAborted(); progress(true); return stats;
}
export async function scan(root: string, rules: string[], strict = false, options: ScanOptions = {}): Promise<Manifest> {
  const files: Manifest = Object.create(null);
  await walkFiles(root, rules, strict, (p,c) => { files[p] = c; }, options); return files;
}
export async function scanIndex(root: string, rules: string[], options: ScanOptions = {}) {
  const files: string[] = [];
  const stats = await walkFiles(root, rules, false, p => files.push(p), options); return { files: files.sort(), stats };
}
