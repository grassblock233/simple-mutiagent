import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  checkLocalRequest,
  openSession,
  requireSession,
  readJson,
  SESSION_COOKIE,
} from "../lib/server/security";
import { Storage } from "../lib/server/storage";
import { TestWorkflowEngine as WorkflowEngine } from "./engine-fixture";
import { createTemplate } from "../lib/workflow/templates";

function request(headers: Record<string, string> = {}, body?: string) {
  return new Request("http://127.0.0.1:3000/api/test", {
    method: body ? "POST" : "GET",
    headers: { host: "127.0.0.1:3000", ...headers },
    body,
  });
}
test("本地 Host、Origin、Referer 和站点来源校验", () => {
  checkLocalRequest(request());
  checkLocalRequest(
    request({
      origin: "http://127.0.0.1:3000",
      "sec-fetch-site": "same-origin",
    }),
  );
  const cases: Record<string, string>[] = [
    { host: "attacker.example" },
    { origin: "http://localhost:3000" },
    { referer: "http://example.com/" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ];
  for (const headers of cases)
    assert.throws(() => checkLocalRequest(request(headers)));
});
test("会话和写操作令牌绑定；只持有 Cookie 不能写入", () => {
  assert.throws(() => requireSession(request()), /会话/);
  const { session } = openSession(request());
  const headers = {
    cookie: `${SESSION_COOKIE}=${session.id}`,
    "Content-Type": "application/json",
  };
  assert.equal(requireSession(request(headers)).id, session.id);
  assert.throws(() => requireSession(request(headers, "{}"), true), /令牌/);
  assert.equal(
    requireSession(
      request({ ...headers, "x-workflow-csrf": session.token }, "{}"),
      true,
    ).id,
    session.id,
  );
  assert.throws(() =>
    requireSession(
      request(
        { ...headers, "x-workflow-csrf": "é".repeat(session.token.length) },
        "{}",
      ),
      true,
    ),
  );
  assert.equal(openSession(request(headers)).fresh, false);
});
test("请求体解析拒绝坏 JSON 和超过上限的分块内容", async () => {
  assert.deepEqual(await readJson(request({}, '{"ok":true}')), { ok: true });
  await assert.rejects(() => readJson(request({}, "{bad")), /JSON/);
  await assert.rejects(
    () => readJson(request({}, "x".repeat(1024 * 1024 + 1))),
    /1 MiB/,
  );
});
test("工作流保存原子替换、权限受限、读取再次校验", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simple-workflow-"));
  try {
    const storage = new Storage(root);
    assert.equal(await storage.loadWorkflow(), null);
    await storage.saveWorkflow(createTemplate());
    const flow = await storage.loadWorkflow();
    assert.deepEqual(flow, createTemplate());
    assert.equal(
      (await stat(path.join(root, "workflow.json"))).mode & 0o777,
      0o600,
    );
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal(
      (await readdir(root)).some((f) => f.endsWith(".tmp")),
      false,
    );
    await storage.saveWorkflow(createTemplate("review"));
    assert.equal((await storage.loadWorkflow())?.nodes.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("持久化：JSONL 顺序、报告、差异和私有基线独立保存并可删除", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-artifacts-"));
  try {
    const storage = new Storage(root);
    const engine = new WorkflowEngine(createTemplate("review"), async ({ node, state }) => node.kind === "read" ? { type: "material", version: state.currentVersion, paths: state.scope } : { type: "review", version: state.currentVersion, scope: state.scope, issues: [], validations: [], limitations: [] });
    await engine.start();
    const state = engine.snapshot();
    await storage.saveRun(state);
    await storage.saveBaseline(state.id, { "src/a.ts": "private source" });
    assert.deepEqual((await readFile(path.join(root, "events", state.id + ".jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line).seq), state.events.map(e => e.seq));
    assert.match(await readFile(path.join(root, "reports", state.id + ".md"), "utf8"), /审查|测试夹具/);
    assert.equal((await storage.listRuns())[0].id, state.id);
    assert.deepEqual(await storage.loadBaseline(state.id), { "src/a.ts": "private source" });
    await storage.removeRun(state.id);
    assert.equal((await storage.listRuns()).length, 0);
    await assert.rejects(storage.loadBaseline(state.id));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("重启标记中断及审核过期，不恢复命令或执行器", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simple-workflow-"));
  try {
    const engine = new WorkflowEngine(
      createTemplate(),
      async () => new Promise(() => {}),
      { id: randomUUID() },
    );
    const state = engine.snapshot();
    state.status = "awaiting_approval";
    state.approvals.push({
      id: randomUUID(),
      runId: state.id,
      nodeId: "review",
      round: 0,
      version: "test-v0",
      executable: "node",
      args: ["--test"],
      cwd: ".",
      purpose: "测试夹具",
      artifacts: [],
      displayHash: "0".repeat(64),
      status: "pending",
      environment: "local-minimal-env-v1",
      createdAt: state.createdAt,
    });
    const storage = new Storage(root);
    await storage.saveRun(state);
    await storage.markInterrupted();
    const saved = JSON.parse(
      await readFile(path.join(root, "runs", `${state.id}.json`), "utf8"),
    );
    assert.equal(saved.status, "interrupted");
    assert.equal(saved.conclusion, "execution_failed");
    assert.equal(saved.approvals[0].status, "expired");
    assert.equal(saved.events.at(-1).type, "interrupted");
    await storage.markInterrupted();
    const repeated = JSON.parse(
      await readFile(path.join(root, "runs", `${state.id}.json`), "utf8"),
    );
    assert.equal(repeated.events.length, saved.events.length);
    await assert.rejects(
      () => storage.saveRun({ ...state, id: "../../outside" }),
      /标识/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("历史兼容：旧演练记录不载入、不展示，启动不将其改写为真实记录", async () => {
  const { writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "workflow-legacy-"));
  try {
    const storage = new Storage(root);
    const state = new WorkflowEngine(createTemplate(), async () => null).snapshot();
    await storage.saveRun(state);
    const legacy = { ...state, mode: "synthetic", status: "running" };
    const filename = path.join(root, "runs", `${state.id}.json`);
    await writeFile(filename, JSON.stringify(legacy));
    await storage.markInterrupted();
    assert.deepEqual(await storage.listRuns(), []);
    await assert.rejects(storage.loadRun(state.id), /历史格式/);
    assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), legacy);
  } finally { await rm(root, { recursive: true, force: true }); }
});
