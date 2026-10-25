import { legacyWorkflow } from "./legacy-workflow-fixture";
import { test } from "node:test";
import { writeFileSync as requireWrite } from "node:fs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceRegistry, WorkingCopy } from "../lib/runtime/workspace";
import { SafeRoot, version, excluded } from "../lib/runtime/files";
import { Transactions } from "../lib/runtime/transaction";
import { availableCommands, executeCommand, commandEnvironment, redact } from "../lib/runtime/commands";
import { createDeepSeekClient, type CompletionClient, type Message } from "../lib/runtime/deepseek";
import { createAgentRunner, type RuntimeEvidence } from "../lib/runtime/agent";
import { WorkflowEngine } from "../lib/workflow/engine";
import { createTemplate } from "../lib/workflow/templates";
import type { ReviewResult } from "../lib/workflow/schema";

async function fixture(files: Record<string, string>, selection = [{ path: "src", directory: true }]) {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-runtime-"));
  const project = path.join(root, "project"), data = path.join(root, "data");
  await mkdir(project);
  for (const [name, content] of Object.entries(files)) { const target = path.join(project, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); }
  const registry = new WorkspaceRegistry(data);
  const workspace = await registry.open(project, "owner");
  const copy = await WorkingCopy.create(workspace, selection, path.join(data, "copy"));
  return { root, project, data, registry, workspace, copy, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("真实工作区：固定范围、未勾选读取、排除规则与独立副本", async () => {
  const f = await fixture({ "src/a.ts": "one", "context.ts": "context", ".env.local": "secret" });
  try {
    assert.deepEqual(f.copy.scope(), ["src/a.ts"]);
    const v = await f.copy.currentVersion();
    assert.equal((await f.copy.read("context.ts", v)).content, "context");
    await assert.rejects(f.copy.patch("context.ts", "context", "bad", v), /范围/);
    await assert.rejects(f.copy.read(".env.local", v), /排除/);
    await f.copy.patch("src/new.ts", null, "new", v);
    assert.equal(await readFile(path.join(f.project, "src/a.ts"), "utf8"), "one");
    assert.equal((await f.copy.changes()).length, 1);
    assert.throws(() => f.registry.get(f.workspace.id, "other"));
    await assert.rejects(f.registry.open(f.root, "owner"), /分离/);
  } finally { await f.cleanup(); }
});

test("真实路径：穿越、外部链接、硬链接和文件类型替换均拒绝", async () => {
  const f = await fixture({ "src/a.ts": "safe" });
  try {
    const safe = await new SafeRoot(f.project).initialize();
    await writeFile(path.join(f.root, "outside"), "outside");
    await symlink(f.root, path.join(f.project, "escape"));
    for (const p of ["../outside", path.join(f.root, "outside"), "escape/outside"]) await assert.rejects(safe.read(p));
    await assert.rejects(safe.write("escape/new", null, "bad"));
    await link(path.join(f.root, "outside"), path.join(f.project, "hardlink"));
    await assert.rejects(safe.read("hardlink"), /硬链接/);
    assert.equal(await readFile(path.join(f.root, "outside"), "utf8"), "outside");
    await symlink(path.join(f.root, "outside"), path.join(f.copy.root, "src/link.ts"));
    await assert.rejects(f.copy.checkedChanges(), /符号链接/);
  } finally { await f.cleanup(); }
});

test("排除规则：嵌套目录、目录后代及单选文件的创建边界", async () => {
  assert.equal(excluded("src/generated/a.ts", ["src/generated/"]), true);
  assert.equal(excluded("src/generated/a.ts", ["src/generated/*.ts"]), true);
  assert.equal(excluded("src/deep/nested/a.ts", ["src/**/a.ts"]), true);
  assert.equal(excluded("src/generation/a.ts", ["src/generated/"]), false);
  const f = await fixture({ "src/a.ts": "a", "src/b.ts": "b" }, [{ path: "src/a.ts", directory: false }]);
  try {
    await assert.rejects(f.copy.patch("src/new.ts", null, "new", await f.copy.currentVersion()), /范围/);
    await assert.rejects(f.copy.patch("src/b.ts", "b", "new", await f.copy.currentVersion()), /范围/);
  } finally { await f.cleanup(); }
});

test("部分撤销保留恢复记录与备份并阻止后续应用", async () => {
  const f = await fixture({ "src/a.ts": "a", "src/b.ts": "b" });
  try {
    let v = await f.copy.currentVersion(); v = await f.copy.patch("src/a.ts", "a", "A", v); v = await f.copy.patch("src/b.ts", "b", "B", v);
    const transactions = new Transactions(path.join(f.data, "transactions"));
    const record = await transactions.apply(f.copy, "run", v);
    const failingUndo = new Transactions(path.join(f.data, "transactions"), (stage, file) => { if (stage === "undo" && file === "src/a.ts") throw new Error("injected undo failure"); });
    const partial = await failingUndo.undo(record.id, "run");
    assert.equal(partial.status, "needs_recovery");
    assert.deepEqual(partial.processed, ["src/b.ts"]);
    assert.equal(await readFile(path.join(f.project, "src/b.ts"), "utf8"), "b");
    assert.equal(await readFile(path.join(f.project, "src/a.ts"), "utf8"), "A");
    await assert.rejects(transactions.apply(f.copy, "another", v), /未解决文件事务/);
  } finally { await f.cleanup(); }
});

test("API 密钥不主动注入；日志截断可见且版本变化拒绝旧审核执行", async () => {
  const f = await fixture({ "src/a.ts": "safe", "large.test.cjs": "process.stdout.write('x'.repeat(1100000));" });
  try {
    const allowed = await availableCommands(f.copy);
    const v = await f.copy.currentVersion();
    const result = await executeCommand({ copy: f.copy, command: allowed[0], allowed, version: v, nodeId: "review", round: 0, signal: new AbortController().signal });
    assert.equal(result.stdoutTruncated, true); assert.ok(Buffer.byteLength(result.stdout) <= 1024 * 1024);
    await f.copy.patch("src/a.ts", "safe", "changed", v);
    await assert.rejects(executeCommand({ copy: f.copy, command: allowed[0], allowed, version: v, nodeId: "review", round: 0, signal: new AbortController().signal }), /版本冲突/);
  } finally { await f.cleanup(); }
});

test("文件事务：新增、修改、删除与完整撤销，备份权限受限", async () => {
  const f = await fixture({ "src/a.ts": "old", "src/delete.ts": "delete" });
  try {
    let v = await f.copy.currentVersion(); v = await f.copy.patch("src/a.ts", "old", "new", v);
    v = await f.copy.patch("src/delete.ts", "delete", null, v);
    v = await f.copy.patch("src/add.ts", null, "added", v);
    const transactions = new Transactions(path.join(f.data, "transactions"));
    const record = await transactions.apply(f.copy, "run", v);
    assert.equal(record.status, "applied");
    assert.equal(await readFile(path.join(f.project, "src/a.ts"), "utf8"), "new");
    await assert.rejects(readFile(path.join(f.project, "src/delete.ts")));
    assert.equal((await stat(path.join(f.data, "transactions", record.id + ".json"))).mode & 0o777, 0o600);
    const undone = await transactions.undo(record.id, "run");
    assert.equal(undone.status, "undone");
    assert.equal(await readFile(path.join(f.project, "src/a.ts"), "utf8"), "old");
    assert.equal(await readFile(path.join(f.project, "src/delete.ts"), "utf8"), "delete");
    await assert.rejects(readFile(path.join(f.project, "src/add.ts")));
    assert.equal((await transactions.undo(record.id, "run")).status, "undone");
  } finally { await f.cleanup(); }
});

test("整批应用与撤销：任一冲突均零写入", async () => {
  const f = await fixture({ "src/a.ts": "a", "src/b.ts": "b" });
  try {
    let v = await f.copy.currentVersion(); v = await f.copy.patch("src/a.ts", "a", "A", v); v = await f.copy.patch("src/b.ts", "b", "B", v);
    const transactions = new Transactions(path.join(f.data, "transactions"));
    await writeFile(path.join(f.project, "src/b.ts"), "external");
    await assert.rejects(transactions.apply(f.copy, "run", v), /基线冲突/);
    assert.equal(await readFile(path.join(f.project, "src/a.ts"), "utf8"), "a");
    await writeFile(path.join(f.project, "src/b.ts"), "b");
    const applied = await transactions.apply(f.copy, "run", v);
    await writeFile(path.join(f.project, "src/b.ts"), "external");
    await assert.rejects(transactions.undo(applied.id, "run"), /撤销冲突/);
    assert.equal(await readFile(path.join(f.project, "src/a.ts"), "utf8"), "A");
  } finally { await f.cleanup(); }
});

test("应用部分失败恢复已写入文件；中断事务不自动重放", async () => {
  const f = await fixture({ "src/a.ts": "a", "src/b.ts": "b" });
  try {
    let v = await f.copy.currentVersion(); v = await f.copy.patch("src/a.ts", "a", "A", v); v = await f.copy.patch("src/b.ts", "b", "B", v);
    const transactions = new Transactions(path.join(f.data, "transactions"), (_, file) => { if (file === "src/b.ts") throw new Error("injected"); });
    const record = await transactions.apply(f.copy, "run", v);
    assert.equal(record.status, "rolled_back");
    assert.deepEqual(record.recovered, ["src/a.ts"]);
    assert.equal(await readFile(path.join(f.project, "src/a.ts"), "utf8"), "a");
    record.status = "applying";
    await writeFile(path.join(f.data, "transactions", record.id + ".json"), JSON.stringify(record));
    await transactions.markInterrupted();
    assert.equal((await transactions.load(record.id)).status, "needs_recovery");
    assert.equal(await readFile(path.join(f.project, "src/a.ts"), "utf8"), "a");
  } finally { await f.cleanup(); }
});

test("本机执行：真实启动、最小环境、输出脱敏、产物排除、越界源码阻止应用", async () => {
  const f = await fixture({ "src/a.ts": "safe", "check.test.cjs": "const fs=require('node:fs'); fs.writeFileSync('.workflow-tmp/output', 'artifact'); console.log(process.env.DEEPSEEK_API_KEY || 'NO_KEY');" });
  try {
    const commands = await availableCommands(f.copy);
    assert.equal(commandEnvironment(f.copy.root).DEEPSEEK_API_KEY, undefined);
    const result = await executeCommand({ copy: f.copy, command: commands[0], allowed: commands, version: await f.copy.currentVersion(), nodeId: "review", round: 0, signal: new AbortController().signal });
    assert.equal(result.status, "passed"); assert.match(result.stdout, /NO_KEY/);
    assert.deepEqual(result.changedPaths, []);
    assert.deepEqual(await f.copy.changes(), []);
    await writeFile(path.join(f.copy.root, "check.test.cjs"), "outside change");
    await assert.rejects(f.copy.checkedChanges(), /范围外/);
    assert.equal(redact("Bearer abc sk-abcdefghijklmnop", []), "Bearer [REDACTED] [REDACTED]");
  } finally { await f.cleanup(); }
});

test("本机执行：超时及取消终止受管理子进程组", async () => {
  const f = await fixture({ "src/a.ts": "safe", "hang.test.cjs": "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000);" });
  try {
    const allowed = await availableCommands(f.copy);
    const options = { copy: f.copy, command: allowed[0], allowed, version: await f.copy.currentVersion(), nodeId: "review", round: 0, timeoutMs: 100 };
    const timed = await executeCommand({ ...options, signal: new AbortController().signal });
    assert.equal(timed.status, "timed_out");
    const abort = new AbortController();
    const running = executeCommand({ ...options, timeoutMs: 5000, signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    assert.equal((await running).status, "cancelled");
  } finally { await f.cleanup(); }
});

test("DeepSeek 协议：真实请求形状、思考历史完整回传、截断拒绝与有限重试", async () => {
  let attempts = 0;
  const messages: Message[] = [{ role: "system", content: "system secret" }, { role: "assistant", content: "no tools", reasoning_content: "preserve this" }];
  const client = createDeepSeekClient({ apiKey: "secret", transport: async (url, init) => {
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    const body = JSON.parse(init!.body as string);
    assert.equal(body.messages[0].content, "system [REDACTED]");
    assert.equal(body.messages[1].reasoning_content, "preserve this");
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.equal(body.reasoning_effort, "high");
    attempts++;
    if (attempts === 1) return new Response("", { status: 503 });
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "okay" } }], usage: { prompt_tokens: 2, completion_tokens: 3 } });
  } });
  const config = { model: "deepseek-flash" as const, thinking: true, reasoningEffort: "high" as const, maxOutputTokens: 8192 };
  const result = await client(messages, [], config, new AbortController().signal, "review");
  assert.equal(attempts, 2); assert.equal(result.usage.promptTokens, 2); assert.equal(result.usage.cacheHitTokens, null);
  const truncated = createDeepSeekClient({ apiKey: "secret", transport: async () => Response.json({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "{}" } }] }) });
  await assert.rejects(truncated(messages, [], config, new AbortController().signal, "review"), /截断/);
});

function scriptedClient(): CompletionClient {
  return async (messages, _, __, ___, nodeId) => {
    const first = JSON.parse((messages[1] as { content: string }).content);
    const done = messages.filter(m => m.role === "tool");
    const last = done.at(-1) as { content: string } | undefined;
    const current = last ? JSON.parse(last.content).version ?? first.version : first.version;
    let name: string, args: unknown;
    if (!done.length) { name = "read_file"; args = { path: "src/math.js", version: first.version, startLine: 1, endLine: 1 }; }
    else if (nodeId === "repair" && done.length === 1) { name = "submit_patch"; args = { path: "src/math.js", version: first.version, before: "module.exports=(a,b)=>a-b;", after: "module.exports=(a,b)=>a+b;" }; }
    else if (nodeId === "rereview" && done.length === 1) { name = "request_check"; args = { commandIndex: 0, version: first.version }; }
    else {
      name = "submit_result";
      if (nodeId === "repair") args = { resolutions: [{ issueId: "I-1", explanation: "fixed" }], unrepairable: [] };
      else args = { type: "review", version: first.version, scope: first.scope, issues: [{ id: nodeId === "review" ? "candidate" : "I-1", path: "src/math.js", version: first.version, startLine: 1, endLine: 1, severity: "blocking", description: "wrong operator", evidence: "a-b", suggestion: "a+b", status: nodeId === "review" ? "open" : "resolved" }], validations: [], limitations: [] } satisfies ReviewResult;
    }
    void current;
    return { assistant: { role: "assistant", content: null, reasoning_content: "private", tool_calls: [{ id: nodeId + done.length, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, usage: { nodeId, model: "deepseek-flash", time: new Date().toISOString(), durationMs: 1, promptTokens: 10, completionTokens: 10, cacheHitTokens: null, cacheMissTokens: null } };
  };
}

test("真实文件与进程端到端：审查→补丁→复审→逐次批准→应用→撤销（模型协议替身）", async () => {
  const f = await fixture({ "src/math.js": "module.exports=(a,b)=>a-b;", "math.test.cjs": "require('node:assert/strict').equal(require('./src/math.js')(2,1),3);" });
  try {
    const allowed = await availableCommands(f.copy);
    const evidence: RuntimeEvidence = { reads: [], commands: [], usage: [] };
    const flow = createTemplate();
    const rereview = flow.nodes.find(n => n.kind === "rereview")!;
    if (rereview.kind === "rereview") rereview.config.requireValidation = true;
    const engine: WorkflowEngine = new WorkflowEngine(flow, createAgentRunner(f.copy, allowed, scriptedClient(), evidence), { real: { scope: f.copy.scope(), baselineVersion: version(f.copy.baseline), workspace: { id: f.workspace.id, root: f.project, selection: f.copy.selection, excludes: f.workspace.excludes }, allowPath: p => f.copy.canWrite(p), allowCommand: () => true }, onChange: state => { const pending = state.approvals.find(a => a.status === "pending"); if (pending) queueMicrotask(() => engine.decideApproval(pending.id, pending.displayHash, "approved")); } });
    await engine.start();
    const state = engine.snapshot();
    assert.equal(state.conclusion, "passed", state.exitReason);
    assert.equal(state.round, 1); assert.equal(evidence.commands.length, 1); assert.equal(evidence.commands[0].status, "passed");
    assert.equal(await readFile(path.join(f.project, "src/math.js"), "utf8"), "module.exports=(a,b)=>a-b;");
    const transactions = new Transactions(path.join(f.data, "transactions"));
    const applied = await transactions.apply(f.copy, state.id, state.currentVersion);
    assert.equal(applied.status, "applied");
    assert.equal(await readFile(path.join(f.project, "src/math.js"), "utf8"), "module.exports=(a,b)=>a+b;");
    assert.equal((await transactions.undo(applied.id, state.id)).status, "undone");
  } finally { await f.cleanup(); }
});

test("失败模型尝试：HTTP 重试与截断分别保留未知或实际用量", async () => {
  const usage: RuntimeEvidence["usage"] = [];
  let attempts = 0;
  const client = createDeepSeekClient({ apiKey: "secret", onUncertain: item => usage.push(item), transport: async () => {
    if (++attempts === 1) return new Response("", { status: 503 });
    return Response.json({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "partial" } }], usage: { prompt_tokens: 11, completion_tokens: 12 } });
  } });
  await assert.rejects(client([], [], { model: "deepseek-flash", thinking: false, reasoningEffort: "low", maxOutputTokens: 10 }, new AbortController().signal, "review"), /截断/);
  assert.equal(usage.length, 2); assert.equal(usage[0].uncertain, true); assert.equal(usage[1].completionTokens, 12);
});

test("撤销恢复原文件权限；回滚遭并发编辑时保留恢复备份", async () => {
  const f = await fixture({ "src/a.ts": "a", "src/b.ts": "b" });
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(path.join(f.project, "src/a.ts"), 0o771);
    let v = await f.copy.patch("src/a.ts", "a", null, await f.copy.currentVersion());
    const transactions = new Transactions(path.join(f.data, "transactions"));
    const applied = await transactions.apply(f.copy, "mode", v);
    await transactions.undo(applied.id, "mode");
    assert.equal((await stat(path.join(f.project, "src/a.ts"))).mode & 0o777, 0o771);
    v = await f.copy.patch("src/a.ts", null, "A", v); v = await f.copy.patch("src/b.ts", "b", "B", v);
    const failing = new Transactions(path.join(f.data, "transactions"), (_, file) => {
      if (file === "src/b.ts") {
        // A trusted fault hook models an external editor during a batch, before rollback.
        requireWrite(path.join(f.project, "src/a.ts"), "external");
        throw new Error("injected");
      }
    });
    const record = await failing.apply(f.copy, "race", v);
    assert.equal(record.status, "needs_recovery");
    assert.equal(await readFile(path.join(f.project, "src/a.ts"), "utf8"), "external");
    await assert.rejects(transactions.removeRun("race"), /未解决/);
  } finally { await f.cleanup(); }
});

function engineFor(f: Awaited<ReturnType<typeof fixture>>, flow: ReturnType<typeof createTemplate>, runner: ReturnType<typeof createAgentRunner>, onChange?: (state: import("../lib/workflow/schema").RunState) => void, nodeTimeoutMs?: number) {
  return new WorkflowEngine(flow, runner, { real: { scope: f.copy.scope(), baselineVersion: version(f.copy.baseline), workspace: { id: f.workspace.id, root: f.project, selection: f.copy.selection, excludes: f.workspace.excludes }, allowPath: p => f.copy.canWrite(p), allowCommand: () => true }, onChange, nodeTimeoutMs });
}

function oneTool(name: string, args: unknown, id: string): Awaited<ReturnType<CompletionClient>> {
  return { assistant: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, usage: { nodeId: "review", model: "deepseek-flash", time: new Date().toISOString(), durationMs: 1, promptTokens: 1, completionTokens: 1, cacheHitTokens: null, cacheMissTokens: null } };
}

test("真实 Agent：范围外命令变更立即停止，不能用后续结果掩盖", async () => {
  const f = await fixture({ "src/a.js": "safe", "change.test.cjs": "require('node:fs').writeFileSync('outside.js','bad');" });
  try {
    let calls = 0;
    const evidence: RuntimeEvidence = { reads: [], commands: [], usage: [] };
    const client: CompletionClient = async messages => { calls++; return oneTool("request_check", { commandIndex: 0, version: JSON.parse((messages[1] as { content: string }).content).version }, "check"); };
    const engine = engineFor(f, legacyWorkflow("review"), createAgentRunner(f.copy, await availableCommands(f.copy), client, evidence), state => { const a = state.approvals.find(a => a.status === "pending"); if (a) queueMicrotask(() => engine.decideApproval(a.id, a.displayHash, "approved")); });
    await engine.start();
    assert.equal(engine.snapshot().conclusion, "execution_failed"); assert.match(engine.snapshot().exitReason!, /范围外/); assert.equal(calls, 1); assert.equal(evidence.commands.length, 1);
  } finally { await f.cleanup(); }
});

test("取消真实命令：最终证据保存；节点耗时包含审核等待", async () => {
  const f = await fixture({ "src/a.js": "safe", "hang.test.cjs": "setInterval(()=>{},1000);" });
  try {
    const allowed = await availableCommands(f.copy);
    const client: CompletionClient = async messages => oneTool("request_check", { commandIndex: 0, version: JSON.parse((messages[1] as { content: string }).content).version }, "check");
    const evidence: RuntimeEvidence = { reads: [], commands: [], usage: [] };
    const engine = engineFor(f, legacyWorkflow("review"), createAgentRunner(f.copy, allowed, client, evidence), state => { const a = state.approvals.find(a => a.status === "pending"); if (a) queueMicrotask(() => { engine.decideApproval(a.id, a.displayHash, "approved"); setTimeout(() => engine.cancel(), 100); }); });
    await engine.start(); await evidence.pending;
    engine.captureEvidence({ reads: evidence.reads, commands: evidence.commands, usage: evidence.usage });
    assert.equal(engine.snapshot().conclusion, "cancelled"); assert.equal(engine.snapshot().commands?.[0].status, "cancelled");
    const timeout = engineFor(f, legacyWorkflow("review"), createAgentRunner(f.copy, allowed, client, { reads: [], commands: [], usage: [] }), undefined, 40);
    await timeout.start();
    assert.equal(timeout.snapshot().conclusion, "execution_failed"); assert.match(timeout.snapshot().exitReason!, /耗时预算/); assert.equal(timeout.snapshot().approvals[0].status, "expired");
  } finally { await f.cleanup(); }
});

test("修复节点的必要验证被拒绝，停止为验证未完成", async () => {
  const f = await fixture({ "src/math.js": "module.exports=(a,b)=>a-b;", "math.test.cjs": "require('node:assert/strict').equal(require('./src/math.js')(2,1),3);" });
  try {
    const flow = createTemplate();
    const repair = flow.nodes.find(n => n.kind === "repair")!;
    if (repair.kind === "repair") repair.config.requireValidation = true;
    const engine = engineFor(f, flow, createAgentRunner(f.copy, await availableCommands(f.copy), scriptedClient(), { reads: [], commands: [], usage: [] }));
    await engine.start();
    assert.equal(engine.snapshot().conclusion, "validation_incomplete"); assert.equal(engine.snapshot().applicationStatus, "not_applied");
    assert.equal(engine.snapshot().records.filter(r => r.kind === "rereview" && r.status === "completed").length, 0);
  } finally { await f.cleanup(); }
});

test("缺失模块清楚记录为不可用验证，禁止假称测试通过", async () => {
  const f = await fixture({ "src/a.js": "safe", "deps.test.cjs": "require('missing-workflow-example-module');" });
  try {
    const allowed = await availableCommands(f.copy);
    const record = await executeCommand({ copy: f.copy, command: allowed[0], allowed, version: await f.copy.currentVersion(), nodeId: "review", round: 0, signal: new AbortController().signal });
    assert.equal(record.status, "unavailable"); assert.match(record.stderr, /验证未完成/);
  } finally { await f.cleanup(); }
});

function repairSequenceClient(steps: ("read" | "fix" | "break" | "refine" | "check0" | "check1")[]): CompletionClient {
  const fallback = scriptedClient();
  return async (messages, tools, config, signal, nodeId) => {
    if (nodeId !== "repair") return fallback(messages, tools, config, signal, nodeId);
    const input = JSON.parse((messages[1] as { content: string }).content);
    const outputs = messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content!));
    const current = outputs.findLast(result => result.version)?.version ?? input.version;
    const step = steps[outputs.length];
    if (step === "read") return oneTool("read_file", { path: "src/math.js", version: current, startLine: 1, endLine: 1 }, `repair-${outputs.length}`);
    if (step === "check0" || step === "check1") return oneTool("request_check", { commandIndex: step === "check0" ? 0 : 1, version: current }, `repair-${outputs.length}`);
    if (step === "fix" || step === "break" || step === "refine") {
      const previousPatch = steps.slice(0, outputs.length).findLast(s => s === "fix" || s === "break");
      const before = previousPatch === "fix" ? "module.exports=(a,b)=>a+b;" : previousPatch === "break" ? "module.exports=(a,b)=>a*b;" : "module.exports=(a,b)=>a-b;";
      return oneTool("submit_patch", { path: "src/math.js", version: current, before, after: step === "refine" ? "module.exports=(a,b)=>a + b;" : step === "fix" ? "module.exports=(a,b)=>a+b;" : "module.exports=(a,b)=>a*b;" }, `repair-${outputs.length}`);
    }
    return oneTool("submit_result", { resolutions: [{ issueId: input.originalIssues[0].id, explanation: "fixed" }], unrepairable: [] }, `repair-${outputs.length}`);
  };
}

for (const [name, steps, expected, extraTest] of [
  ["通过后再次修改代码，旧验证不能放行最终版本", ["read", "fix", "check0", "break"], "validation_incomplete", false],
  ["同一版本有成功和失败的必要检查，不能以成功掩盖失败", ["read", "fix", "check1", "check0"], "execution_failed", true],
  ["修改后不能用其他成功检查替代未重跑的必要检查", ["read", "check1", "fix", "check0"], "validation_incomplete", true],
  ["修改后重新验证最终版本，允许正常完成", ["read", "fix", "check0", "refine", "check0"], "passed", false],
] as const) {
  test(`修复必要验证：${name}`, async () => {
    const f = await fixture({ "src/math.js": "module.exports=(a,b)=>a-b;", "math.test.cjs": "require('node:assert/strict').equal(require('./src/math.js')(2,1),3);", ...(extraTest ? { "z-required.test.cjs": "throw new Error('required failure');" } : {}) });
    try {
      const flow = createTemplate();
      const repair = flow.nodes.find(n => n.kind === "repair")!;
      if (repair.kind === "repair") repair.config.requireValidation = true;
      const evidence: RuntimeEvidence = { reads: [], commands: [], usage: [] };
      const engine = engineFor(f, flow, createAgentRunner(f.copy, await availableCommands(f.copy), repairSequenceClient([...steps]), evidence), state => {
        const approval = state.approvals.find(a => a.status === "pending");
        if (approval) queueMicrotask(() => engine.decideApproval(approval.id, approval.displayHash, "approved"));
      });
      await engine.start();
      assert.equal(engine.snapshot().conclusion, expected, engine.snapshot().exitReason);
      assert.equal(engine.snapshot().applicationStatus, "not_applied");
      assert.equal(await readFile(path.join(f.project, "src/math.js"), "utf8"), "module.exports=(a,b)=>a-b;");
      assert.ok(evidence.commands.some(command => command.status === "passed"));
      if (extraTest) assert.ok(evidence.commands.some(command => command.status === "failed"));
      if (expected !== "passed") assert.equal(engine.snapshot().records.some(r => r.kind === "rereview" && r.status === "completed"), false);
    } finally { await f.cleanup(); }
  });
}
