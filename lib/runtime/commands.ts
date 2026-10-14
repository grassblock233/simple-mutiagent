import { spawn } from "node:child_process";
import { access, realpath, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WorkingCopy } from "./workspace";

export const LOCAL_EXECUTION_NOTICE = "本机执行，未启用文件与网络隔离。命令及子进程可访问宿主文件和网络；文件事务不覆盖事务之外的副作用。";
export type CommandDefinition = { executable: string; args: string[]; purpose: string; artifacts: string[] };
export type CommandRecord = {
  id: string; nodeId: string; round: number; version: string; afterVersion?: string;
  executable: string; args: string[]; cwd: string; environment: string;
  status: "rejected" | "passed" | "failed" | "unavailable" | "timed_out" | "cancelled";
  exitCode: number | null; stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean;
  startedAt: string; finishedAt: string; changedPaths: string[];
};
export function redact(value: string, secrets: string[] = [process.env.DEEPSEEK_API_KEY ?? ""]) {
  for (const secret of secrets) if (secret) value = value.split(secret).join("[REDACTED]");
  return value.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]").replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]");
}
export async function availableCommands(copy: WorkingCopy): Promise<CommandDefinition[]> {
  const files = Object.keys(copy.baseline);
  const commands: CommandDefinition[] = [];
  for (const file of files.filter(p => /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?js|[cm]?ts)$/.test(p)).slice(0, 30)) {
    commands.push({ executable: await realpath(process.execPath), args: ["--test", file], purpose: `运行 ${file}`, artifacts: [] });
  }
  if (copy.baseline["package.json"]) {
    let scripts: Record<string, unknown> = {};
    try { scripts = JSON.parse(copy.baseline["package.json"]).scripts ?? {}; } catch { /* Invalid package.json remains reviewable. */ }
    let npm: string | undefined;
    for (const directory of [path.dirname(process.execPath), "/usr/bin", "/usr/local/bin"]) {
      try { const candidate = path.join(directory, "npm"); await access(candidate, constants.X_OK); npm = await realpath(candidate); break; } catch { /* Try next trusted directory. */ }
    }
    if (npm) for (const script of ["test", "check", "lint", "typecheck", "build"]) {
      if (typeof scripts[script] === "string") commands.push({ executable: npm, args: ["run", script, "--offline", "--ignore-scripts"], purpose: `运行项目 ${script} 脚本：${scripts[script]}`, artifacts: ["可能产生缓存、覆盖率或构建产物"] });
    }
  }
  return commands;
}
export function checkCommand(command: CommandDefinition, allowed: CommandDefinition[]) {
  if (!allowed.some(c => c.executable === command.executable && JSON.stringify(c.args) === JSON.stringify(command.args))) throw new Error("命令不在本次固定白名单内");
}
export function commandEnvironment(copyRoot: string): NodeJS.ProcessEnv {
  return {
    PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: path.join(copyRoot, ".workflow-home"), TMPDIR: path.join(copyRoot, ".workflow-tmp"),
    LANG: "C.UTF-8", CI: "1", NODE_ENV: "test", npm_config_offline: "true", npm_config_ignore_scripts: "true",
  };
}
export async function executeCommand(options: {
  copy: WorkingCopy; command: CommandDefinition; allowed: CommandDefinition[]; version: string;
  nodeId: string; round: number; signal: AbortSignal; timeoutMs?: number;
}): Promise<CommandRecord> {
  const { copy, command, signal } = options;
  checkCommand(command, options.allowed);
  if (process.platform !== "linux") throw new Error("本机进程组管理当前仅支持 Linux");
  await copy.assertVersion(options.version);
  if (command.args[0] === "run") {
    const currentPackage = await copy.safe.read("package.json");
    if (!currentPackage || JSON.stringify(JSON.parse(currentPackage).scripts) !== JSON.stringify(JSON.parse(copy.baseline["package.json"]).scripts)) throw new Error("项目脚本已变化，原白名单说明失效；请重新运行后审核");
  }
  if (signal.aborted) throw new Error("运行已取消");
  const before = await copy.manifest();
  const env = commandEnvironment(copy.root);
  await mkdir(env.HOME!, { recursive: true, mode: 0o700 });
  await mkdir(env.TMPDIR!, { recursive: true, mode: 0o700 });
  const record: CommandRecord = { id: randomUUID(), nodeId: options.nodeId, round: options.round, version: options.version, ...command, cwd: copy.root, environment: "local-minimal-env-v1", status: "failed", exitCode: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, startedAt: new Date().toISOString(), finishedAt: "", changedPaths: [] };
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, { cwd: copy.root, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let force: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (signal: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } };
    const stop = (status: "timed_out" | "cancelled") => {
      if (record.status === "timed_out" || record.status === "cancelled") return;
      record.status = status; killGroup("SIGTERM");
      force = setTimeout(() => killGroup("SIGKILL"), 500);
    };
    const cancel = () => stop("cancelled");
    const timer = setTimeout(() => stop("timed_out"), options.timeoutMs ?? 120_000);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const limit = 1024 * 1024;
      const size = Buffer.byteLength(record[stream]);
      if (size + chunk.length > limit) record[`${stream}Truncated`] = true;
      if (size < limit) record[stream] += chunk.subarray(0, limit - size).toString("utf8");
    };
    child.stdout.on("data", chunk => append("stdout", chunk));
    child.stderr.on("data", chunk => append("stderr", chunk));
    const cleanup = () => { clearTimeout(timer); if (force) clearTimeout(force); signal.removeEventListener("abort", cancel); };
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", code => {
      // Also stop managed descendants that outlive the parent.
      killGroup("SIGKILL"); cleanup(); record.exitCode = code;
      if (!["timed_out", "cancelled"].includes(record.status)) record.status = code === 0 ? "passed" : "failed";
      resolve();
    });
  });
  record.stdout = redact(record.stdout); record.stderr = redact(record.stderr);
  if (record.status === "failed" && /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:module|package)|(?:sh:|bash:).*not found/.test(record.stderr + record.stdout)) {
    record.status = "unavailable";
    record.stderr += "\n验证所需模块或程序不可用。副本不复制 node_modules，也不自动安装依赖；本次验证未完成。";
  }
  record.finishedAt = new Date().toISOString();
  const after = await copy.manifest();
  const { differences, version } = await import("./files");
  record.afterVersion = version(after);
  record.changedPaths = differences(before, after).map(c => c.path);
  return record;
}
