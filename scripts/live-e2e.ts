import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTemplate } from '../lib/workflow/templates';
import type { RunState } from '../lib/workflow/schema';
const require = createRequire(import.meta.url);
createRequire(require.resolve('next/package.json'))('@next/env').loadEnvConfig(process.cwd());
const key = process.env.DEEPSEEK_API_KEY;
let server: ChildProcess | undefined;
let root = '', base = '', cookie = '', token = '';
async function api(route: string, method = 'GET', value?: unknown) {
  const response = await fetch(base + route, { method, headers: { cookie, 'content-type': 'application/json', 'x-workflow-csrf': token }, body: value === undefined ? undefined : JSON.stringify(value) });
  const data = await response.json();
  assert.equal(JSON.stringify(data).includes(key!), false, 'API exposed configured key');
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${data.error}`);
  return data;
}
async function runScenario(name: string, mode: 'confirm' | 'automatic', kind: 'repair' | 'review' | 'reject' | 'persistent') {
  const project = path.join(root, name);
  await cp(path.resolve('examples', kind === 'persistent' ? 'unrepairable' : 'repairable'), project, { recursive: true });
  if (kind === 'review') {
    const file = path.join(project, 'src/math.mjs');
    await writeFile(file, (await readFile(file, 'utf8')).replace('a - b', 'a + b'));
  }
  const original = await readFile(path.join(project, kind === 'persistent' ? 'src/provider.mjs' : 'src/math.mjs'), 'utf8');
  const workspace = await api('/api/workspaces', 'POST', { path: project });
  const workflow = createTemplate(kind === 'review' ? 'review' : 'full');
  for (const node of workflow.nodes) if (node.kind === 'review' || node.kind === 'repair' || node.kind === 'rereview') {
    node.config.reasoningEffort = 'low';
    node.config.requireValidation = kind !== 'persistent' && (node.kind === 'rereview' || kind === 'review');
    node.config.prompt = kind === 'persistent'
      ? '审查 src/provider.mjs。缺失的私有 provider 是阻塞问题。严禁编造或模拟 provider，也不能删除 TODO_EXTERNAL 标记或改变 loadProvider 抛错的契约。修复阶段仅可补充一条说明，说明仍需 provider 所有者交付实现；无法解决时如实保留问题并结束。复审须明确保留原问题编号为 open。无需运行命令。'
      : node.kind === 'review'
        ? '读取 src/math.mjs 和测试，仅审查 add 是否正确返回数字之和。正确时 issues 为空；若使用减法则报告一个有准确位置的 blocking 问题。初始审查不要求运行失败测试；若本节点 requireValidation=true 则必须请求索引0的检查。只提交有证据的问题。'
        : node.kind === 'repair'
          ? '只修复原审查指出的 add 减法错误，保持测试不变；先读取当前源码，使用 submit_patch，再 submit_result，说明原问题处理。不要额外重构。'
          : '读取修改后的 src/math.mjs 和测试，复核原问题。必须用 request_check 请求索引0的测试并等待结果。通过后将原问题（保留原编号）标为 resolved；拒绝测试则如实提交验证缺失，不得自报通过。';
  }
  let state: RunState = await api('/api/runs', 'POST', { mode: 'real', workflow, workspaceId: workspace.id, selection: [{ path: 'src', directory: true }], repairMode: mode, requestId: randomUUID() });
  const streamAbort = new AbortController();
  const stream = await fetch(`${base}/api/runs/${state.id}/events`, { headers: { cookie }, signal: streamAbort.signal });
  const consume = (async () => { const reader = stream.body!.getReader(); try { while (!(await reader.read()).done) { /* Keep the actual approval UI subscription alive. */ } } catch { /* closed */ } })();
  let previous = '', approvals = 0;
  const decided = new Set<string>();
  const started = Date.now();
  try {
    while (Date.now() - started < 600_000) {
      state = await api(`/api/runs/${state.id}`);
      const status = `${state.status}:${state.currentNodeId ?? 'result'}`;
      if (status !== previous) { console.log(`${name}: ${status}`); previous = status; }
      for (const approval of state.approvals.filter(a => a.status === 'pending' && !decided.has(a.id))) {
        assert.equal(approval.environment, 'local-minimal-env-v1');
        const target = path.join(project, kind === 'persistent' ? 'src/provider.mjs' : 'src/math.mjs');
        assert.equal(await readFile(target, 'utf8'), original, 'original changed before application');
        decided.add(approval.id); approvals++;
        const body = { id: approval.id, displayHash: approval.displayHash, decision: kind === 'reject' ? 'rejected' : 'approved' };
        await api(`/api/runs/${state.id}/approval`, 'POST', body);
        const duplicate = await fetch(`${base}/api/runs/${state.id}/approval`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-workflow-csrf': token }, body: JSON.stringify(body) });
        assert.equal(duplicate.status, 409, 'approval consumed more than once');
      }
      if (!['pending','running','awaiting_approval','finalizing'].includes(state.status)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(!['pending','running','awaiting_approval','finalizing'].includes(state.status), 'live run deadline');
    if (kind === 'reject') { assert.equal(state.conclusion, 'validation_incomplete', state.exitReason); assert.equal(state.applicationStatus, 'not_applied'); }
    else if (kind === 'persistent') { assert.equal(state.conclusion, 'issues_remaining', state.exitReason); assert.equal(state.round, 1); }
    else assert.equal(state.conclusion, 'passed', `${state.exitReason}; ${JSON.stringify(state.records.filter(r => r.error))}`);
    if (kind !== 'persistent') assert.ok(approvals >= 1, 'required test had no approval');
    if (kind === 'repair' && mode === 'confirm') {
      assert.equal(state.applicationStatus, 'awaiting_confirmation');
      state = await api(`/api/runs/${state.id}/apply`, 'POST', { version: state.currentVersion });
      assert.equal(state.applicationStatus, 'applied');
    }
    if (kind === 'repair') {
      assert.equal(state.applicationStatus, 'applied');
      assert.notEqual(await readFile(path.join(project,'src/math.mjs'),'utf8'), original);
      state = await api(`/api/runs/${state.id}/undo`, 'POST', {});
      assert.equal(state.applicationStatus, 'undone');
      assert.equal(await readFile(path.join(project,'src/math.mjs'),'utf8'), original);
    }
    if (kind === 'persistent' && state.applicationStatus === 'applied') state = await api(`/api/runs/${state.id}/undo`, 'POST', {});
    for (const format of ['md', 'json']) {
      const response = await fetch(`${base}/api/runs/${state.id}/report?format=${format}`, { headers: { cookie } });
      assert.equal(response.status, 200);
      const text = await response.text(); assert.ok(!text.includes(key!)); assert.ok(!text.includes('reasoning_content'));
      await writeFile(path.resolve(`docs/examples/reports/${name}.${format}`), text.replaceAll(root, '/tmp/simple-workflow-example'));
    }
    console.log(`${name}: verified ${state.conclusion}, ${state.applicationStatus}, approvals=${approvals}, modelCalls=${state.usage?.length}`);
    return { name, conclusion: state.conclusion, applicationStatus: state.applicationStatus, approvals, modelCalls: state.usage?.length, readPaths: [...new Set(state.reads?.map(r => r.path))], commandStatuses: state.commands?.map(c => c.status), rounds: state.round };
  } finally { streamAbort.abort(); await consume; }
}
async function main() {
  if (!key) throw new Error('DEEPSEEK_API_KEY is required');
  root = await mkdtemp(path.join(tmpdir(), 'workflow-live-'));
  const port = await new Promise<number>(resolve => { const probe = createServer(); probe.listen(0,'127.0.0.1',()=>{const address=probe.address(); if(!address || typeof address==='string')throw Error('port'); probe.close(()=>resolve(address.port));});});
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)], { env: { ...process.env, SIMPLE_WORKFLOW_DATA_DIR: path.join(root,'data') }, stdio:'ignore' });
  for (let i=0;i<100;i++) { try {const response=await fetch(base+'/api/session'); if(response.ok){const data=await response.json();cookie=response.headers.get('set-cookie')!.split(';')[0];token=data.csrfToken;break;}}catch{} await new Promise(r=>setTimeout(r,100)); }
  assert.ok(cookie,'server did not start');
  await mkdir('docs/examples/reports',{recursive:true});
  const results=[];
  for (const [name,mode,kind] of [['repairable-confirm','confirm','repair'],['repairable-automatic','automatic','repair'],['review-only','confirm','review'],['reject-validation','automatic','reject'],['round-limit','automatic','persistent']] as const) results.push(await runScenario(name,mode,kind));
  await writeFile('docs/examples/reports/live-verification.json', JSON.stringify({ date:new Date().toISOString(), backend:'DeepSeek Flash official endpoint; actual local processes and HTTP APIs', isolation:'deferred', results },null,2));
}
main().catch(error=>{console.error(error instanceof Error ? error.message.replaceAll(key ?? '\0','[REDACTED]') : 'live verification failed');process.exitCode=1;}).finally(async()=>{if(server && server.exitCode===null){const stopped=new Promise(r=>server!.once('exit',r));server.kill('SIGTERM');await stopped;} if(root)await rm(root,{recursive:true,force:true});});
