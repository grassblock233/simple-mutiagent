import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createTemplate } from "../lib/workflow/templates";
import { legacyWorkflow } from "../tests/legacy-workflow-fixture";
import type { RunState, Workflow } from "../lib/workflow/schema";
const require = createRequire(import.meta.url);
createRequire(require.resolve("next/package.json"))("@next/env").loadEnvConfig(process.cwd());
const secret = process.env.DEEPSEEK_API_KEY;
const base = process.env.VERIFY_BASE_URL ?? "http://127.0.0.1:3000";
const reportDir = path.resolve("docs/reviews/2026-10-25-implementation");
let cookie = "", token = "", fixture = "";
async function api(route: string, method = "GET", value?: unknown) {
  const response = await fetch(base + route, { method, headers: { cookie, "content-type": "application/json", "x-workflow-csrf": token }, body: value === undefined ? undefined : JSON.stringify(value) });
  const data = await response.json();
  assert.ok(!secret || !JSON.stringify(data).includes(secret), "API exposed configured key");
  if (!response.ok) throw Error("HTTP " + response.status + ": " + data.error);
  return data;
}
async function execute(workflow: Workflow, project: string, selection: {path:string;directory:boolean}[]) {
  const workspace = await api("/api/workspaces", "POST", { path: project });
  let state: RunState = await api("/api/runs", "POST", { mode: "real", workflow, workspaceId: workspace.id, selection, repairMode: "confirm", requestId: randomUUID() });
  const abort = new AbortController();
  let last = "";
  const decided = new Set<string>();
  const active = (value: RunState) => ["pending", "running", "awaiting_approval", "finalizing"].includes(value.status);
  async function observe(next: RunState) {
    state = next;
    const status = state.status + ":" + (state.currentNodeId ?? "result");
    if (last !== status) { console.log(workflow.name + ": " + status); last = status; }
    for (const approval of state.approvals.filter(a => a.status === "pending" && !decided.has(a.id))) {
      assert.equal(approval.environment, "local-minimal-env-v1");
      assert.equal(project, fixture, "Only the trusted arithmetic fixture may receive test approval");
      decided.add(approval.id);
      await api("/api/runs/" + state.id + "/approval", "POST", {id:approval.id,displayHash:approval.displayHash,decision:"approved"});
    }
  }
  try {
    for (let connection = 0; active(state) && connection < 3; connection++) {
      try {
        const stream = await fetch(base + "/api/runs/" + state.id + "/events", {headers:{cookie},signal:abort.signal});
        if (!stream.ok || !stream.body) throw Error("SSE connection failed");
        const reader = stream.body.getReader(), decoder = new TextDecoder();
        let buffer = "";
        try {
          while (active(state)) {
            const chunk = await reader.read(); if (chunk.done) break;
            buffer += decoder.decode(chunk.value,{stream:true});
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0,boundary); buffer = buffer.slice(boundary+2);
              if (!frame.split("\n").includes("event: snapshot")) continue;
              const data = frame.split("\n").filter(line=>line.startsWith("data: ")).map(line=>line.slice(6)).join("\n");
              await observe(JSON.parse(data));
            }
          }
        } finally {await reader.cancel().catch(()=>{});}
      } catch (error) { if (connection === 2) throw error; }
      if (active(state)) {
        // Only a broken stream triggers one delayed snapshot lookup per reconnect.
        await new Promise(resolve=>setTimeout(resolve,5000));
        await observe(await api("/api/runs/"+state.id));
      }
    }
    assert.equal(active(state),false,"SSE ended before the run completed");
    assert.ok(["passed","issues_remaining"].includes(state.conclusion!),state.exitReason);
    console.log(workflow.name+": "+state.conclusion+", calls="+state.usage?.length+", issues="+state.issues.length);
    return state;
  } finally {abort.abort();}
}
async function main() {
  assert.ok(secret,"DEEPSEEK_API_KEY missing");
  const response=await fetch(base+"/api/session"); const session=await response.json();
  assert.equal(response.status,200);cookie=response.headers.get("set-cookie")?.split(";")[0] ?? "";token=session.csrfToken;
  await mkdir(reportDir,{recursive:true});
  const review=legacyWorkflow("review");review.name="验收：Test 单文件真实审查";
  const agent=review.nodes.find(n=>n.kind==="review")!;
  if(agent.kind==="review"){agent.config.reasoningEffort="low";agent.config.prompt="仅审查选择范围内 CircularArrayList.java 的边界索引和环形移动逻辑。读取源码后提交有准确行号和证据的问题；没有证据则 issues 为空。不要请求命令，也不要修改文件。";}
  const reviewed=await execute(review,"/home/grass/Desktop/Test/",[{path:"HMCLCore/src/main/java/org/jackhuang/hmcl/util/CircularArrayList.java",directory:false}]);
  await writeFile(path.join(reportDir,"real-review.json"),JSON.stringify(reviewed,null,2));
  fixture=await mkdtemp(path.join(tmpdir(),"workflow-focused-"));await cp(path.resolve("examples/repairable"),fixture,{recursive:true});
  const original=await readFile(path.join(fixture,"src/math.mjs"),"utf8");
  const flow=createTemplate();flow.name="验收：临时项目修复及撤销";
  for(const n of flow.nodes)if(n.kind==="review"||n.kind==="repair"||n.kind==="rereview"){
    n.config.reasoningEffort="low";n.config.requireValidation=n.kind==="rereview";
    n.config.prompt=n.kind==="review"?"读取 src/math.mjs，只报告 add(a,b) 错用减法的一个 blocking 问题，提供准确行号及证据。无需执行命令。":n.kind==="repair"?"仅修复原问题中 add 的减法错误，先读取源码，再 submit_patch，保持测试不变。不要额外重构。":"读取修改后的 src/math.mjs，保留原问题编号。必须 request_check 索引0的测试并等待审核，通过后标为 resolved；不得自报测试通过。";
  }
  let repaired=await execute(flow,fixture,[{path:"src",directory:true}]);
  assert.equal(repaired.conclusion,"passed",repaired.exitReason);assert.equal(repaired.applicationStatus,"awaiting_confirmation");
  assert.equal(await readFile(path.join(fixture,"src/math.mjs"),"utf8"),original);
  repaired=await api("/api/runs/"+repaired.id+"/apply","POST",{version:repaired.currentVersion});assert.equal(repaired.applicationStatus,"applied");
  assert.notEqual(await readFile(path.join(fixture,"src/math.mjs"),"utf8"),original);
  repaired=await api("/api/runs/"+repaired.id+"/undo","POST",{});assert.equal(repaired.applicationStatus,"undone");assert.equal(await readFile(path.join(fixture,"src/math.mjs"),"utf8"),original);
  const query=new URLSearchParams({path:"src/math.mjs",version:repaired.currentVersion,startLine:"1",endLine:"20"});
  const source=await api("/api/runs/"+repaired.id+"/source?"+query);assert.match(source.content,/a \+ b/);
  await writeFile(path.join(fixture,"src/math.mjs"),"unrelated disk edit");
  const same=await api("/api/runs/"+repaired.id+"/source?"+query);assert.equal(same.content,source.content);
  for(const run of [reviewed,repaired])await writeFile(path.join(reportDir,run===reviewed?"real-review.json":"real-repair.json"),JSON.stringify(run,null,2));
  await writeFile(path.join(reportDir,"live-verification.json"),JSON.stringify({date:new Date().toISOString(),base,model:"deepseek-flash",review:{id:reviewed.id,conclusion:reviewed.conclusion,issues:reviewed.issues.length,calls:reviewed.usage?.length},repair:{id:repaired.id,conclusion:repaired.conclusion,application:repaired.applicationStatus,calls:repaired.usage?.length},sourceAfterUndoAndDiskEdit:true},null,2));
  console.log("Focused verification passed; report: "+reportDir);
}
main().catch(error=>{console.error(String(error instanceof Error?error.message:error).replaceAll(secret ?? "\0","[REDACTED]"));process.exitCode=1;}).finally(async()=>{if(fixture)await rm(fixture,{recursive:true,force:true});});
