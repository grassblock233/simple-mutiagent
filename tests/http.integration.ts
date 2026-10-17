import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createTemplate } from "../lib/workflow/templates";
import { type RunState } from "../lib/workflow/schema";
import { Storage } from "../lib/server/storage";
import { WorkingCopy } from "../lib/runtime/workspace";
import { DEFAULT_EXCLUDES, version } from "../lib/runtime/files";
import { TestWorkflowEngine as WorkflowEngine } from "./engine-fixture";

let server: ChildProcess;
let root: string;
let base: string;
let cookie: string;
let token: string;
let output = "";
async function api(
  route: string,
  method = "GET",
  data?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      cookie,
      "Content-Type": "application/json",
      "x-workflow-csrf": token,
      ...headers,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { response, data: await response.json() };
}
async function waitState(id: string, testState: (state: RunState) => boolean) {
  for (let i = 0; i < 250; i++) {
    const result = await api(`/api/runs/${id}`);
    assert.equal(result.response.status, 200);
    if (testState(result.data)) return result.data as RunState;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("运行未在 5 秒内进入预期状态");
}
const projects: string[] = [];
const preload = path.resolve("tests/fixtures/model-transport.mjs");
async function create(kind = "repairable") {
  const project = await mkdtemp(path.join(tmpdir(), "workflow-http-real-"));
  projects.push(project);
  await mkdir(path.join(project, "src"));
  await writeFile(path.join(project, "src/math.js"), ["repairable", "validated-repair"].includes(kind) ? "module.exports=(a,b)=>a-b;" : "module.exports=(a,b)=>a+b;");
  await writeFile(path.join(project, "math.test.cjs"), "require('node:assert/strict').equal(require('./src/math.js')(2,1),3);");
  const opened = await api("/api/workspaces", "POST", { path: project });
  assert.equal(opened.response.status, 200);
  const workflow = createTemplate();
  for (const node of workflow.nodes) if (["review", "repair", "rereview"].includes(node.kind) && "prompt" in node.config) {
    node.config.prompt = `HTTP_TEST:${node.kind}`;
    node.config.requireValidation = (kind === "validation" && node.kind === "review") || (kind === "validated-repair" && node.kind === "rereview");
  }
  const payload = {
    mode: "real", workflow, workspaceId: opened.data.id,
    selection: [{ path: "src", directory: true }],
    repairMode: "confirm", requestId: randomUUID(),
  };
  const result = await api("/api/runs", "POST", payload);
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  return { payload, state: result.data as RunState };
}
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "workflow-http-"));
  const port = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") throw new Error("port");
      const value = address.port;
      probe.close(() => resolve(value));
    });
  });
  base = `http://127.0.0.1:${port}`;
  server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      env: {
        ...process.env,
        SIMPLE_WORKFLOW_DATA_DIR: root,
        DEEPSEEK_API_KEY: "integration-sentinel-not-real",
        NODE_OPTIONS: `--import=${preload}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  server.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`${base}/api/session`);
      const session = await response.json();
      if (response.ok) {
        cookie = response.headers.get("set-cookie")!.split(";")[0];
        token = session.csrfToken;
        return;
      }
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Next.js 服务未启动：${output}`);
});
after(async () => {
  if (server && server.exitCode === null) {
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await stopped;
  }
  if (root) await rm(root, { recursive: true, force: true });
  for (const project of projects) await rm(project, { recursive: true, force: true });
});

test("HTTP：站点来源和 CSRF 拒绝未授权访问", async () => {
  assert.equal(
    (
      await api("/api/session", "GET", undefined, {
        origin: "http://attacker.example",
      })
    ).response.status,
    403,
  );
  assert.equal(
    (
      await api("/api/workflows", "PUT", createTemplate(), {
        "x-workflow-csrf": "",
      })
    ).response.status,
    403,
  );
  assert.equal(
    (await api("/api/workflows", "GET", undefined, { cookie: "" })).response
      .status,
    401,
  );
});
test("HTTP：保存/加载/校验和版本拒绝", async () => {
  assert.equal((await api("/api/workflows")).data.workflow, null);
  assert.equal(
    (await api("/api/workflows", "PUT", createTemplate())).response.status,
    200,
  );
  assert.deepEqual(
    (await api("/api/workflows")).data.workflow,
    createTemplate(),
  );
  const invalid = { ...createTemplate(), formatVersion: 99 };
  assert.equal(
    (await api("/api/workflows/validate", "POST", invalid)).data.valid,
    false,
  );
  assert.equal(
    (await api("/api/runs", "POST", { workflow: invalid })).response.status,
    400,
  );
});
test("HTTP：请求幂等、配置绑定、工作流快照与事件重放", async () => {
  const { payload, state } = await create();
  assert.equal((await api("/api/runs", "POST", payload)).data.id, state.id);
  assert.equal(
    (await api("/api/runs", "POST", { ...payload, repairMode: "automatic" })).response
      .status,
    409,
  );
  assert.equal(
    (await api("/api/runs", "POST", { ...payload, requestId: randomUUID() }))
      .response.status,
    409,
  );
  const finished = await waitState(state.id, (s) => ["completed", "awaiting_confirmation"].includes(s.status));
  assert.equal(finished.conclusion, "passed");
  assert.equal(finished.round, 1);
  const afterSeq = finished.events.length - 3;
  const replay = await fetch(
    `${base}/api/runs/${state.id}/events?after=${afterSeq}`,
    { headers: { cookie } },
  );
  assert.match(replay.headers.get("content-type")!, /text\/event-stream/);
  const data = await replay.text();
  const ids = [...data.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  assert.deepEqual(ids, [afterSeq + 1, afterSeq + 2, afterSeq + 3]);
  assert.match(data, /event: snapshot/);
});
test("HTTP：不同会话不能查看运行；报告不含环境密钥", async () => {
  const { state } = await create("clean");
  await waitState(state.id, (s) => ["completed", "awaiting_confirmation"].includes(s.status));
  const another = await fetch(`${base}/api/session`);
  const anotherCookie = another.headers.get("set-cookie")!.split(";")[0];
  assert.equal(
    (
      await api(`/api/runs/${state.id}`, "GET", undefined, {
        cookie: anotherCookie,
      })
    ).response.status,
    404,
  );
  for (const format of ["md", "json"]) {
    const response = await fetch(
      `${base}/api/runs/${state.id}/report?format=${format}`,
      { headers: { cookie } },
    );
    const report = await response.text();
    assert.equal(response.status, 200);
    assert.equal(report.includes("integration-sentinel-not-real"), false);
    assert.match(response.headers.get("content-disposition")!, /attachment/);
  }
});
test("HTTP：逐次审核拒绝和迟到批准", async () => {
  const { state } = await create("validation");
  const waiting = await waitState(
    state.id,
    (s) => s.status === "awaiting_approval",
  );
  const approval = waiting.approvals[0];
  const payload = {
    id: approval.id,
    displayHash: approval.displayHash,
    decision: "rejected",
  };
  assert.equal(
    (await api(`/api/runs/${state.id}/approval`, "POST", payload)).response
      .status,
    200,
  );
  assert.equal(
    (
      await api(`/api/runs/${state.id}/approval`, "POST", {
        ...payload,
        decision: "approved",
      })
    ).response.status,
    409,
  );
  const finished = await waitState(state.id, (s) => ["completed", "awaiting_confirmation"].includes(s.status));
  assert.equal(finished.conclusion, "validation_incomplete");
  assert.equal(finished.round, 0);
});
test("HTTP：取消幂等，取消后不能审核", async () => {
  const { state } = await create("validation");
  const waiting = await waitState(
    state.id,
    (s) => s.status === "awaiting_approval",
  );
  const first = await api(`/api/runs/${state.id}/cancel`, "POST", {});
  const repeated = await api(`/api/runs/${state.id}/cancel`, "POST", {});
  assert.equal(first.data.status, "cancelled");
  assert.equal(repeated.data.status, "cancelled");
  // Final tool evidence may arrive after cancellation, but cancellation itself is emitted once.
  assert.equal(first.data.events.filter((event: { type: string }) => event.type === "run_finished").length, 1);
  assert.equal(repeated.data.events.filter((event: { type: string }) => event.type === "run_finished").length, 1);
  assert.equal(
    (
      await api(`/api/runs/${state.id}/approval`, "POST", {
        id: waiting.approvals[0].id,
        displayHash: waiting.approvals[0].displayHash,
        decision: "approved",
      })
    ).response.status,
    409,
  );
});

test("HTTP：目录授权绑定会话；外部路径不能替代工作区标识", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "workflow-http-project-"));
  try {
    await writeFile(path.join(project, "a.js"), "export const a = 1;");
    const opened = await api("/api/workspaces", "POST", { path: project });
    assert.equal(opened.response.status, 200);
    assert.deepEqual(opened.data.files, ["a.js"]);
    const otherResponse = await fetch(`${base}/api/session`);
    const otherSession = await otherResponse.json();
    const otherCookie = otherResponse.headers.get("set-cookie")!.split(";")[0];
    const attempted = await api("/api/runs", "POST", { mode: "real", workflow: createTemplate(), workspaceId: opened.data.id, selection: [{ path: "a.js", directory: false }], repairMode: "confirm", requestId: randomUUID() }, { cookie: otherCookie, "x-workflow-csrf": otherSession.csrfToken });
    assert.notEqual(attempted.response.status, 201);
    assert.equal(await readFile(path.join(project, "a.js"), "utf8"), "export const a = 1;");
    const arbitrary = await api("/api/runs", "POST", { mode: "real", workflow: createTemplate(), path: project, selection: [], repairMode: "confirm", requestId: randomUUID() });
    assert.equal(arbitrary.response.status, 400);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test("HTTP：历史副本恢复、版本绑定应用、撤销冲突与明确删除备份", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "workflow-http-transaction-"));
  try {
    await mkdir(path.join(project, "src")); await writeFile(path.join(project, "src/a.js"), "old");
    const id = randomUUID();
    const workspace = { id: randomUUID(), root: project, excludes: DEFAULT_EXCLUDES, files: ["src/a.js"] };
    await mkdir(path.join(root, "copies"), { recursive: true });
    const copy = await WorkingCopy.create(workspace, [{ path: "src", directory: true }], path.join(root, "copies", id));
    await copy.patch("src/a.js", "old", "new", await copy.currentVersion());
    const state = new WorkflowEngine(createTemplate(), async () => null, { id }).snapshot();
    Object.assign(state, { mode: "real", status: "awaiting_confirmation", applicationStatus: "awaiting_confirmation", conclusion: "passed", currentVersion: await copy.currentVersion(), baselineVersion: version(copy.baseline), scope: copy.scope(), workspace: { ...workspace, selection: copy.selection }, changes: await copy.changes(), commands: [], reads: [], usage: [] });
    const storage = new Storage(root);
    await storage.saveBaseline(id, copy.baseline); await storage.saveRun(state);
    assert.ok((await api("/api/history")).data.runs.some((r: { id: string }) => r.id === id));
    assert.equal((await api(`/api/history/${id}`, "POST", {})).data.applicationStatus, "awaiting_confirmation");
    assert.equal((await api(`/api/runs/${id}/apply`, "POST", { version: "stale" })).response.status, 409);
    assert.equal(await readFile(path.join(project, "src/a.js"), "utf8"), "old");
    await writeFile(path.join(project, "src/a.js"), "external");
    assert.equal((await api(`/api/runs/${id}/apply`, "POST", { version: state.currentVersion })).response.status, 409);
    const failed = (await api(`/api/runs/${id}`)).data;
    assert.equal(failed.conclusion, "execution_failed"); assert.equal(failed.reviewConclusion, "passed"); assert.equal(failed.applicationStatus, "apply_failed");
    await writeFile(path.join(project, "src/a.js"), "old");
    const applied = await api(`/api/runs/${id}/apply`, "POST", { version: state.currentVersion });
    assert.equal(applied.data.applicationStatus, "applied");
    assert.equal(applied.data.conclusion, "passed");
    const transactionId = applied.data.transaction.id;
    assert.equal((await api(`/api/runs/${id}/apply`, "POST", { version: state.currentVersion })).data.transaction.id, transactionId);
    await writeFile(path.join(project, "src/a.js"), "external");
    assert.equal((await api(`/api/runs/${id}/undo`, "POST", {})).response.status, 409);
    assert.equal(await readFile(path.join(project, "src/a.js"), "utf8"), "external");
    await writeFile(path.join(project, "src/a.js"), "new");
    assert.equal((await api(`/api/runs/${id}/undo`, "POST", {})).data.applicationStatus, "undone");
    assert.equal(await readFile(path.join(project, "src/a.js"), "utf8"), "old");
    assert.equal((await api(`/api/history/${id}`, "DELETE", {})).response.status, 400);
    assert.equal((await api(`/api/history/${id}`, "DELETE", { acknowledgeLossOfUndo: true })).response.status, 200);
    await assert.rejects(readFile(path.join(root, "transactions", transactionId + ".json")));
    assert.equal((await api(`/api/runs/${id}`)).response.status, 404);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test("HTTP：真实后台重启不重放审核，最新事务恢复后仍可撤销", async () => {
  const { Transactions } = await import("../lib/runtime/transaction");
  const project = await mkdtemp(path.join(tmpdir(), "workflow-http-restart-"));
  try {
    await mkdir(path.join(project, "src")); await writeFile(path.join(project, "src/a.js"), "old");
    const id = randomUUID();
    const workspace = { id: randomUUID(), root: project, excludes: DEFAULT_EXCLUDES, files: ["src/a.js"] };
    const copy = await WorkingCopy.create(workspace, [{ path: "src", directory: true }], path.join(root, "copies", id));
    const v = await copy.patch("src/a.js", "old", "new", await copy.currentVersion());
    const old = await new Transactions(path.join(root, "transactions"), () => { throw new Error("first attempt failed"); }).apply(copy, id, v);
    assert.equal(old.status, "rolled_back");
    await new Promise(resolve => setTimeout(resolve, 2));
    const latest = await new Transactions(path.join(root, "transactions")).apply(copy, id, v);
    const state = new WorkflowEngine(createTemplate(), async () => null, { id }).snapshot();
    Object.assign(state, { mode: "real", status: "completed", applicationStatus: "applied", conclusion: "passed", currentVersion: v, baselineVersion: version(copy.baseline), scope: copy.scope(), workspace: { ...workspace, selection: copy.selection }, changes: await copy.changes(), transaction: old });
    await new Storage(root).saveRun(state); // Model a stale snapshot written before the newest durable journal.
    const pending = await create("validation");
    const waiting = await waitState(pending.state.id, s => s.status === "awaiting_approval");
    for (let i = 0; i < 100; i++) {
      if ((await new Storage(root).loadRun(pending.state.id)).approvals.some(a => a.status === "pending")) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await new Storage(root).loadRun(pending.state.id)).approvals[0]?.status, "pending");
    const stopped = new Promise(resolve => server.once("exit", resolve)); server.kill("SIGTERM"); await stopped;
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", new URL(base).port], { env: { ...process.env, SIMPLE_WORKFLOW_DATA_DIR: root, DEEPSEEK_API_KEY: "integration-sentinel-not-real", NODE_OPTIONS: `--import=${preload}` }, stdio: "ignore" });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        const response = await fetch(`${base}/api/session`);
        if (response.ok) { const session = await response.json(); cookie = response.headers.get("set-cookie")!.split(";")[0]; token = session.csrfToken; ready = true; break; }
      } catch { /* starting */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready);
    const interrupted = (await api(`/api/history/${pending.state.id}`, "POST", {})).data;
    assert.equal(interrupted.status, "interrupted"); assert.equal(interrupted.approvals[0].status, "expired");
    assert.equal(interrupted.events.filter((e: { type: string }) => e.type === "run_started").length, 1);
    assert.equal((await api(`/api/runs/${pending.state.id}/approval`, "POST", { id: waiting.approvals[0].id, displayHash: waiting.approvals[0].displayHash, decision: "approved" })).response.status, 409);
    const restored = (await api(`/api/history/${id}`, "POST", {})).data;
    assert.equal(restored.transaction.id, latest.id); assert.equal(restored.applicationStatus, "applied");
    assert.equal((await api(`/api/runs/${id}/undo`, "POST", {})).data.applicationStatus, "undone");
    assert.equal(await readFile(path.join(project, "src/a.js"), "utf8"), "old");
    assert.equal((await api(`/api/history/${id}`, "DELETE", { acknowledgeLossOfUndo: true })).response.status, 200);
    for (const transaction of [old, latest]) await assert.rejects(readFile(path.join(root, "transactions", transaction.id + ".json")));
  } finally { await rm(project, { recursive: true, force: true }); }
});

test("HTTP：真实运行逐次批准命令、最终确认应用与撤销", async () => {
  const { state } = await create("validated-repair");
  const streamAbort = new AbortController();
  const stream = await fetch(`${base}/api/runs/${state.id}/events`, { headers: { cookie }, signal: streamAbort.signal });
  const consume = (async () => {
    const reader = stream.body!.getReader();
    try { while (!(await reader.read()).done) { /* Keep the approval subscription alive. */ } }
    catch { /* Closed after finalization or test cleanup. */ }
  })();
  try {
    const waiting = await waitState(state.id, s => s.status === "awaiting_approval");
    const approval = waiting.approvals.find(a => a.status === "pending")!;
    const filename = path.join(waiting.workspace!.root, "src/math.js");
    assert.equal(await readFile(filename, "utf8"), "module.exports=(a,b)=>a-b;");
    assert.equal((await api(`/api/runs/${state.id}/approval`, "POST", { id: approval.id, displayHash: approval.displayHash, decision: "approved" })).response.status, 200);
    const finished = await waitState(state.id, s => s.status === "awaiting_confirmation");
    assert.equal(finished.conclusion, "passed");
    assert.equal(finished.commands?.length, 1);
    assert.equal(finished.commands[0].status, "passed");
    assert.equal(finished.commands[0].version, finished.currentVersion);
    assert.equal(await readFile(filename, "utf8"), "module.exports=(a,b)=>a-b;");
    const applied = await api(`/api/runs/${state.id}/apply`, "POST", { version: finished.currentVersion });
    assert.equal(applied.data.applicationStatus, "applied");
    assert.equal(await readFile(filename, "utf8"), "module.exports=(a,b)=>a+b;");
    assert.equal((await api(`/api/runs/${state.id}/undo`, "POST", {})).data.applicationStatus, "undone");
    assert.equal(await readFile(filename, "utf8"), "module.exports=(a,b)=>a-b;");
  } finally { streamAbort.abort(); await consume; }
});

test("HTTP：删除演练后拒绝旧请求格式，旧记录不出现在真实历史中", async () => {
  const workflow = createTemplate();
  for (const payload of [
    { workflow, scenario: "clean", repairMode: "confirm", requestId: randomUUID() },
    { mode: "synthetic", workflow, scenario: "clean", repairMode: "confirm", requestId: randomUUID() },
  ]) assert.equal((await api("/api/runs", "POST", payload)).response.status, 400);
  const state = new WorkflowEngine(workflow, async () => null).snapshot();
  const legacy = { ...state, mode: "synthetic", status: "completed", conclusion: "passed" };
  await writeFile(path.join(root, "runs", `${state.id}.json`), JSON.stringify(legacy));
  assert.equal((await api("/api/history")).data.runs.some((r: { id: string }) => r.id === state.id), false);
  assert.equal((await api(`/api/history/${state.id}`, "POST", {})).response.status, 404);
  assert.equal((await api(`/api/runs/${state.id}/retry`, "POST", { requestId: randomUUID() })).response.status, 404);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "runs", `${state.id}.json`), "utf8")), legacy);
});

test("HTTP：容量满时仍能删除未载入历史，未解决事务仍受保护", async () => {
  const storage = new Storage(root);
  const states: RunState[] = [];
  for (let i = 0; i < 51; i++) {
    const state = new WorkflowEngine(createTemplate("review"), async () => null).snapshot();
    state.status = "completed";
    state.conclusion = "passed";
    await storage.saveRun(state);
    states.push(state);
  }
  let full = false;
  for (const state of states) {
    const restored = await api(`/api/history/${state.id}`, "POST", {});
    if (restored.response.status === 429) { full = true; break; }
    assert.equal(restored.response.status, 200);
  }
  assert.ok(full);
  const target = states.at(-1)!;
  assert.equal((await api(`/api/history/${target.id}`, "POST", {})).response.status, 429);
  // Deletion must inspect durable journals even when a snapshot has no transaction field.
  const transactionId = randomUUID();
  await writeFile(path.join(root, "transactions", `${transactionId}.json`), JSON.stringify({ id: transactionId, runId: target.id, status: "needs_recovery", createdAt: new Date().toISOString() }));
  assert.notEqual((await api(`/api/history/${target.id}`, "DELETE", { acknowledgeLossOfUndo: true })).response.status, 200);
  await storage.loadRun(target.id);
  await readFile(path.join(root, "transactions", `${transactionId}.json`));
  await rm(path.join(root, "transactions", `${transactionId}.json`));
  assert.equal((await api(`/api/history/${target.id}`, "DELETE", { acknowledgeLossOfUndo: true })).response.status, 200);
  await assert.rejects(storage.loadRun(target.id));
  for (const state of states.slice(0, -1)) assert.equal((await api(`/api/history/${state.id}`, "DELETE", { acknowledgeLossOfUndo: true })).response.status, 200);
});
