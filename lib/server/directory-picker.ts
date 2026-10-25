import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { HttpError } from "./security";

type Result = { code: number; stdout: string; stderr: string };
type Run = (file: string, args: string[], signal: AbortSignal) => Promise<Result>;
const run: Run = (file, args, signal) => new Promise((resolve, reject) => {
  let failure: Error | undefined;
  let result: Result;
  const child = execFile(file, args, { signal, shell: false, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") failure = error;
    else result = { code: (error?.code as number | undefined) ?? 0, stdout, stderr };
  });
  // Abort may invoke the callback before the child exits. Hold the dialog lock
  // until its process and output streams have actually closed.
  child.once("close", () => {
    if (failure) reject(failure);
    else resolve(result);
  });
});

async function directory(value: string) {
  if (!path.isAbsolute(value)) throw new Error("absolute directory required");
  const resolved = await realpath(value);
  if (!(await stat(resolved)).isDirectory()) throw new Error("not a directory");
  return resolved;
}

export class DirectoryPicker {
  private active = false;
  constructor(private execute: Run = run, private env: Record<string, string | undefined> = process.env, private home = homedir()) {}

  async pick(initial: string, signal: AbortSignal): Promise<string | null> {
    if (this.active) throw new HttpError(409, "目录选择窗口已打开，请先完成或取消选择");
    if (!this.env.DISPLAY && !this.env.WAYLAND_DISPLAY)
      throw new HttpError(503, "没有可用的图形会话，请手动输入项目路径");
    this.active = true;
    try {
      let start: string;
      try { start = await directory(initial); } catch { start = await directory(this.home); }
      const tools = [
        { file: "zenity", args: ["--file-selection", "--directory", "--title=选择项目目录", `--filename=${start.endsWith(path.sep) ? start : start + path.sep}`] },
        { file: "kdialog", args: ["--getexistingdirectory", start, "--title", "选择项目目录"] },
      ];
      for (const tool of tools) {
        signal.throwIfAborted();
        let result: Result;
        try { result = await this.execute(tool.file, tool.args, signal); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        signal.throwIfAborted();
        if (result.code === 1 && !result.stderr.trim()) return null;
        if (result.code !== 0) throw new HttpError(503, "系统目录选择器启动或运行失败，请手动输入项目路径");
        // Remove only the dialog's final newline; spaces are valid path characters.
        const selected = result.stdout.replace(/\r?\n$/, "");
        try { return await directory(selected); }
        catch { throw new HttpError(400, "所选目录不可访问，请重新选择或手动输入路径"); }
      }
      throw new HttpError(503, "未安装系统目录选择器（zenity 或 kdialog），请手动输入项目路径");
    } catch (error) {
      if (signal.aborted) return null;
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "无法打开系统目录选择器，请手动输入项目路径");
    } finally { this.active = false; }
  }
}

// Keep one dialog across route reloads in development as well as across sessions.
const globalPicker = globalThis as typeof globalThis & { workflowDirectoryPicker?: DirectoryPicker };
export const directoryPicker = globalPicker.workflowDirectoryPicker ??= new DirectoryPicker();
