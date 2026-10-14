"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  MarkerType,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import { createNode, createTemplate } from "@/lib/workflow/templates";
import {
  labels,
  nodeKinds,
  workflowSchema,
  type DemoScenario,
  type RunState,
  type Workflow,
  type WorkflowNode,
} from "@/lib/workflow/schema";
import { validateWorkflow } from "@/lib/workflow/validate";
import { conclusions, statuses, applicationStatuses } from "@/lib/workflow/report";
import { WorkflowCard, type CanvasNode } from "./workflow-node";
import { NodeConfig } from "./node-config";
import { newestSnapshot } from "@/lib/workflow/snapshot";

const nodeTypes = { workflow: WorkflowCard };
const scenarios: Record<DemoScenario, string> = {
  clean: "审查无阻塞问题",
  repairable: "修复后复审通过",
  persistent: "轮数内仍无法解决",
  validation: "逐次审核验证",
  failure: "模拟模型超时",
};
const activeStatuses = ["pending", "running", "awaiting_approval", "finalizing"];
function download(name: string, value: string) {
  const url = URL.createObjectURL(
    new Blob([value], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
function Studio() {
  const [workflow, setWorkflow] = useState<Workflow>(() => createTemplate());
  const [selectedId, select] = useState("review");
  const [selectedEdge, selectEdge] = useState<string>();
  const [measurements, setMeasurements] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const [csrf, setCsrf] = useState("");
  const [history, setHistory] = useState<{ id: string; name: string; createdAt: string; status: RunState["status"]; applicationStatus: RunState["applicationStatus"] }[]>([]);
  const [acknowledgeDeletion, setAcknowledgeDeletion] = useState(false);
  const [modelConfigured, setModelConfigured] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspace, setWorkspace] = useState<{ id: string; root: string; files: string[]; excludes: string[] }>();
  const [selection, setSelection] = useState<{ path: string; directory: boolean }[]>([]);
  const [excludes, setExcludes] = useState<string>();
  const [browse, setBrowse] = useState<{ root: string; parent: string; directories: { name: string; path: string }[] }>();
  const [run, setRun] = useState<RunState>();
  const [scenario, setScenario] = useState<DemoScenario>("repairable");
  const [repairMode, setRepairMode] = useState<"confirm" | "automatic">(
    "confirm",
  );
  const [notice, setNotice] = useState(
    "编辑流程后可运行合成演练，所有文件均为虚拟示例。",
  );
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"events" | "results" | "diff">("events");
  const importRef = useRef<HTMLInputElement>(null);
  const validation = useMemo(() => validateWorkflow(workflow), [workflow]);
  const selected = workflow.nodes.find((n) => n.id === selectedId);
  const running = run && activeStatuses.includes(run.status);
  const runId = run?.id;
  useEffect(() => {
    let disposed = false;
    fetch("/api/session", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (!disposed) {
          setCsrf(data.csrfToken);
          setModelConfigured(data.capabilities.modelConfigured);
          const lastId = localStorage.getItem("simple-workflow-last-run");
          if (lastId) {
            let response = await fetch(`/api/runs/${encodeURIComponent(lastId)}`, { cache: "no-store" });
            if (response.status === 404) response = await fetch(`/api/history/${encodeURIComponent(lastId)}`, { method: "POST", headers: { "Content-Type": "application/json", "x-workflow-csrf": data.csrfToken }, body: "{}" });
            if (response.ok && !disposed) {
              const restored: RunState = await response.json();
              setRun(current => current ?? restored);
              setNotice("已恢复上次运行显示；不会自动重放模型请求、命令或文件应用。");
            }
          }
        }
      })
      .catch((error) => {
        if (!disposed) setNotice(error.message);
      });
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    if (!runId) return;
    localStorage.setItem("simple-workflow-last-run", runId);
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.addEventListener("snapshot", (event) => {
      const state: RunState = JSON.parse(event.data);
      setRun((current) =>
        current && current.id !== state.id
          ? current
          : newestSnapshot(current, state),
      );
      if (!activeStatuses.includes(state.status)) source.close();
      if (!activeStatuses.includes(state.status))
        setNotice(
          `运行结束：${state.conclusion ? conclusions[state.conclusion] : statuses[state.status]}；文件状态：${applicationStatuses[state.applicationStatus]}`,
        );
    });
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED)
        setNotice("事件连接中断，正在重连；断开时待审核请求会过期。");
    };
    return () => source.close();
  }, [runId]);
  async function api(url: string, method = "GET", value?: unknown) {
    const response = await fetch(url, {
      method,
      cache: "no-store",
      headers:
        method === "GET"
          ? {}
          : { "Content-Type": "application/json", "x-workflow-csrf": csrf },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "请求失败");
    return result;
  }
  async function action(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  function updateNode(node: WorkflowNode) {
    setWorkflow((w) => ({
      ...w,
      nodes: w.nodes.map((n) => (n.id === node.id ? node : n)),
    }));
  }
  function nodeChanges(changes: NodeChange<CanvasNode>[]) {
    const dimensionChanges = changes.filter((c) => c.type === "dimensions");
    if (dimensionChanges.length)
      setMeasurements((previous) => {
        let next = previous;
        for (const change of dimensionChanges) {
          if (
            change.dimensions &&
            (previous[change.id]?.width !== change.dimensions.width ||
              previous[change.id]?.height !== change.dimensions.height)
          )
            next = { ...next, [change.id]: change.dimensions };
        }
        return next;
      });
    if (
      !changes.some(
        (c) => c.type === "remove" || (c.type === "position" && c.position),
      )
    )
      return;
    setWorkflow((w) => {
      const removed = new Set(
        changes.filter((c) => c.type === "remove").map((c) => c.id),
      );
      return {
        ...w,
        nodes: w.nodes
          .filter((n) => !removed.has(n.id))
          .map((n) => {
            const change = changes.find(
              (c) => c.type === "position" && c.id === n.id,
            );
            return change?.type === "position" && change.position
              ? { ...n, position: change.position }
              : n;
          }),
        edges: w.edges.filter(
          (e) => !removed.has(e.source) && !removed.has(e.target),
        ),
      };
    });
  }
  function edgeChanges(changes: EdgeChange[]) {
    const removed = new Set(
      changes.filter((c) => c.type === "remove").map((c) => c.id),
    );
    if (removed.size)
      setWorkflow((w) => ({
        ...w,
        edges: w.edges.filter((e) => !removed.has(e.id)),
      }));
  }
  function connect(connection: Connection) {
    if (!connection.sourceHandle || connection.targetHandle !== "in") return;
    setWorkflow((w) => ({
      ...w,
      edges: [
        ...w.edges,
        {
          id: crypto.randomUUID(),
          source: connection.source,
          sourcePort: connection.sourceHandle!,
          target: connection.target,
          targetPort: "in",
        },
      ],
    }));
  }
  const nodes: CanvasNode[] = useMemo(
    () =>
      workflow.nodes.map((node) => ({
        id: node.id,
        type: "workflow",
        position: node.position,
        selected: node.id === selectedId,
        measured: measurements[node.id],
        data: {
          node,
          status: run?.records.findLast((r) => r.nodeId === node.id)?.status,
          invalid: validation.errors.some((e) => e.nodeId === node.id),
        },
      })),
    [workflow.nodes, selectedId, run, validation.errors, measurements],
  );
  const edges = workflow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourcePort,
    targetHandle: "in",
    type: "smoothstep",
    selected: selectedEdge === edge.id,
    label: edge.sourcePort === "next" ? undefined : edge.sourcePort,
    markerEnd: { type: MarkerType.ArrowClosed },
    style: {
      stroke:
        edge.sourcePort === "continue"
          ? "#a78bfa"
          : validation.errors.some((e) => e.edgeId === edge.id)
            ? "#f87171"
            : "#718096",
    },
  }));
  const approval = run?.approvals.find((a) => a.status === "pending");
  const nodeRecords = run?.records.filter((r) => r.nodeId === selectedId) ?? [];
  const changes =
    run?.records.flatMap((r) =>
      r.output?.type === "repair"
        ? r.output.changes.map((c) => ({ ...c, round: r.round }))
        : [],
    ) ?? [];
  return (
    <div className="studio">
      <header className="topbar">
        <div className="brand-mark">
          s<span>·</span>w
        </div>
        <div className="brand">
          <strong>Simple Workflow</strong>
          <span>本地多 Agent 工作流</span>
        </div>
        <span className="local-pill">
          <i /> LOCAL
        </span>
        <div className="topbar-spacer" />
        <span className="phase-pill">本地审查与修复</span>
        <button
          className="primary"
          disabled={!csrf || busy || Boolean(running) || !validation.valid}
          onClick={() =>
            action(async () => {
              setRun(
                await api("/api/runs", "POST", {
                  workflow,
                  scenario,
                  repairMode,
                  requestId: crypto.randomUUID(),
                }),
              );
              setView("events");
              setNotice("正在运行合成演练；编辑配置仅影响下一次运行。");
            })
          }
        >
          ▷ 运行合成演练
        </button>
      </header>
      <div className="capability-banner">
        <span className="demo-badge">本机运行</span>
        <span>代码通过 DeepSeek API 处理。命令逐次审核；本机执行，未启用文件与网络隔离。</span>
        <span className="key-status">
          密钥：{modelConfigured ? "已配置" : "未配置"}
        </span>
      </div>
      <main className="workbench">
        <aside className="workspace panel">
          <div className="panel-title">
            <h2>工作区</h2>
            <span>01</span>
          </div>
          <label>本地项目路径
            <input aria-label="本地项目路径" placeholder="/home/用户名/project" value={workspacePath} onChange={e => setWorkspacePath(e.target.value)} />
          </label>
          <div className="toolbar-buttons">
            <button disabled={busy || !csrf} onClick={() => action(async () => { setBrowse(await api(`/api/workspaces?path=${encodeURIComponent(workspacePath)}`)); })}>浏览目录</button>
            <button disabled={busy || !csrf || !workspacePath} onClick={() => action(async () => {
              const next = await api("/api/workspaces", "POST", { path: workspacePath, ...(excludes === undefined ? {} : { excludes: excludes.split("\n").map(s => s.trim()).filter(Boolean) }) });
              setWorkspace(next); setSelection([]); setExcludes(next.excludes.join("\n"));
              setNotice("工作区已建立，请勾选审查/修改范围。未勾选关联文件可被读取。");
            })}>打开项目</button>
          </div>
          {browse && <div className="directory-browser">
            <button onClick={() => action(async () => { setWorkspacePath(browse.parent); setBrowse(await api(`/api/workspaces?path=${encodeURIComponent(browse.parent)}`)); })}>↑ 上级目录</button>
            <button onClick={() => { setWorkspacePath(browse.root); setBrowse(undefined); }}>选择此目录</button>
            {browse.directories.map(d => <button key={d.path} onClick={() => action(async () => { setWorkspacePath(d.path); setBrowse(await api(`/api/workspaces?path=${encodeURIComponent(d.path)}`)); })}>▸ {d.name}</button>)}
          </div>}
          <details><summary>排除规则</summary>
            <textarea aria-label="排除规则" value={excludes ?? ""} placeholder="打开项目后展示默认规则；每行一条" onChange={e => setExcludes(e.target.value)} />
            <p className="help">修改后需重新打开项目。取消敏感文件排除可能将其内容发送至远端模型。</p>
          </details>
          <h3>审查与修改范围（下次运行）</h3>
          {workspace ? <>
            <small>{workspace.root}</small>
            <div className="file-tree real-file-tree">
              {[...new Set(workspace.files.flatMap(f => f.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))))].sort().map(directory => <label key={directory} className="scope-row">
                <input type="checkbox" checked={selection.some(s => s.directory && s.path === directory)} onChange={e => setSelection(old => e.target.checked ? [...old.filter(s => s.path !== directory), { path: directory, directory: true }] : old.filter(s => s.path !== directory))} />▾ {directory}/
              </label>)}
              {workspace.files.map(file => <label key={file} className="scope-row">
                <input type="checkbox" checked={selection.some(s => s.path === file || (s.directory && file.startsWith(s.path + "/")))} disabled={selection.some(s => s.directory && file.startsWith(s.path + "/"))} onChange={e => setSelection(old => e.target.checked ? [...old, { path: file, directory: false }] : old.filter(s => s.path !== file))} />{file}
              </label>)}
            </div>
            <p className="help">已选 {selection.length} 项。勾选目录允许在其内新增/删除文本文件；单选文件不扩大到同目录。</p>
          </> : <p className="help">打开本地目录后显示可访问文本文件。合成演练仍使用虚拟示例。</p>}
          <div className="separator" />
          <h3>添加预置节点</h3>
          <div className="node-palette">
            {nodeKinds.map((kind, i) => (
              <button
                key={kind}
                onClick={() => {
                  const id = `${kind}_${crypto.randomUUID().slice(0, 8)}`;
                  const node = createNode(
                    kind,
                    id,
                    80 + (workflow.nodes.length % 4) * 240,
                    650,
                  );
                  setWorkflow((w) => ({ ...w, nodes: [...w.nodes, node] }));
                  select(id);
                }}
              >
                <span className={`palette-icon kind-${kind}`}>{i + 1}</span>
                {labels[kind]}
                <span className="plus">+</span>
              </button>
            ))}
          </div>
          <div className="workspace-note">
            Linux · 普通文本副本<br />
            最多 1000 文件 / 16 MiB<br />
            不复制依赖，不自动安装<br />
            缺少依赖时验证无法完成<br />
            单条活动路径
            <br />
            一个受控修复循环
            <br />
            修复上限 1–5 轮
          </div>
        </aside>
        <section className="canvas-section">
          <div className="canvas-toolbar">
            <div>
              <span className="eyebrow">WORKFLOW</span>
              <input
                className="workflow-name"
                aria-label="工作流名称"
                value={workflow.name}
                onChange={(e) =>
                  setWorkflow({ ...workflow, name: e.target.value })
                }
              />
            </div>
            <div className="toolbar-buttons">
              <select
                aria-label="加载默认模板"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) {
                    setWorkflow(
                      createTemplate(e.target.value as "full" | "review"),
                    );
                    select("review");
                    selectEdge(undefined);
                  }
                  e.target.value = "";
                }}
              >
                <option value="" disabled>
                  默认模板
                </option>
                <option value="full">完整流程</option>
                <option value="review">仅审查</option>
              </select>
              <button
                disabled={!csrf || busy || !validation.valid}
                onClick={() =>
                  action(async () => {
                    await api("/api/workflows", "PUT", workflow);
                    setNotice("工作流已保存到本地数据目录。");
                  })
                }
              >
                保存
              </button>
              <button
                disabled={!csrf || busy}
                onClick={() =>
                  action(async () => {
                    const result = await api("/api/workflows");
                    if (result.workflow) {
                      setWorkflow(result.workflow);
                      select(result.workflow.nodes[0].id);
                      setNotice("已加载保存的工作流。");
                    } else setNotice("尚无已保存工作流。");
                  })
                }
              >
                加载
              </button>
              <button onClick={() => importRef.current?.click()}>导入</button>
              <button
                disabled={!validation.valid}
                onClick={() =>
                  download(
                    "workflow.json",
                    JSON.stringify(workflowSchema.parse(workflow), null, 2),
                  )
                }
              >
                导出
              </button>
              <input
                hidden
                type="file"
                ref={importRef}
                accept=".json,application/json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  action(async () => {
                    if (file.size > 1024 * 1024)
                      throw new Error("工作流文件超过 1 MiB");
                    const parsed = validateWorkflow(
                      JSON.parse(await file.text()),
                    );
                    if (!parsed.valid)
                      throw new Error(
                        parsed.errors.map((error) => error.message).join("；"),
                      );
                    setWorkflow(parsed.workflow!);
                    select(parsed.workflow!.nodes[0].id);
                    setNotice("工作流已导入，格式与语义校验通过。");
                  });
                  e.target.value = "";
                }}
              />
            </div>
          </div>
          <div className="canvas">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={nodeChanges}
              onEdgesChange={edgeChanges}
              onConnect={connect}
              onNodeClick={(_, node) => {
                select(node.id);
                selectEdge(undefined);
              }}
              onEdgeClick={(_, edge) => selectEdge(edge.id)}
              fitView
              minZoom={0.2}
              maxZoom={1.5}
              colorMode="dark"
              aria-label="工作流画布"
            >
              <Background color="#283344" gap={22} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeColor="#334155" />
            </ReactFlow>
          </div>
          <div
            className={`validation-bar ${validation.valid ? "valid" : "has-errors"}`}
          >
            <span>
              {validation.valid
                ? "✓ 图校验通过"
                : `! ${validation.errors.length} 项待修正`}
            </span>
            <span>
              {workflow.nodes.length} 个节点 · {workflow.edges.length}{" "}
              条控制连线
            </span>
            {selectedEdge && (
              <button
                onClick={() => {
                  setWorkflow((w) => ({
                    ...w,
                    edges: w.edges.filter((e) => e.id !== selectedEdge),
                  }));
                  selectEdge(undefined);
                }}
              >
                删除选中连线
              </button>
            )}
          </div>
          {!validation.valid && (
            <div className="validation-errors">
              {validation.errors.map((error, i) => (
                <button
                  key={i}
                  onClick={() => {
                    if (error.nodeId) select(error.nodeId);
                    if (error.edgeId) selectEdge(error.edgeId);
                  }}
                >
                  {error.nodeId || error.edgeId || "流程"} · {error.message}
                </button>
              ))}
            </div>
          )}
        </section>
        <aside className="configuration panel">
          <div className="panel-title">
            <h2>节点配置</h2>
            <span>02</span>
          </div>
          {selected ? (
            <NodeConfig
              key={selected.id}
              node={selected}
              update={updateNode}
              remove={() => {
                setWorkflow((w) => ({
                  ...w,
                  nodes: w.nodes.filter((n) => n.id !== selected.id),
                  edges: w.edges.filter(
                    (e) => e.source !== selected.id && e.target !== selected.id,
                  ),
                }));
                select("");
              }}
            />
          ) : (
            <p className="help">点击画布上的节点查看配置。</p>
          )}
          <div className="separator" />
          <h3>下一次演练</h3>
          <label>
            合成场景
            <select
              value={scenario}
              onChange={(e) => setScenario(e.target.value as DemoScenario)}
            >
              {Object.entries(scenarios).map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            修复模式快照
            <select
              value={repairMode}
              onChange={(e) =>
                setRepairMode(e.target.value as "confirm" | "automatic")
              }
            >
              <option value="confirm">确认后写入</option>
              <option value="automatic">自动写入</option>
            </select>
          </label>
          <p className="help">确认模式在查看最终差异后写回；自动模式在结束且验证完整时写回。两种模式的命令均逐次审核。</p>
          <button className="primary" disabled={!csrf || busy || Boolean(running) || !validation.valid || !modelConfigured || !workspace || !selection.length} onClick={() => action(async () => {
            setRun(await api("/api/runs", "POST", { mode: "real", workflow, workspaceId: workspace!.id, selection, repairMode, requestId: crypto.randomUUID() }));
            setView("events"); setNotice("真实运行已启动；范围与配置已固定，编辑仅影响下次运行。");
          })}>运行真实工作流</button>
          {!modelConfigured && <p className="help">在 .env.local 中配置 DEEPSEEK_API_KEY 并重启服务后可启动真实运行。</p>}
          <div className="separator" />
          <h3>本地运行历史</h3>
          <button disabled={busy || !csrf} onClick={() => action(async () => { setHistory((await api("/api/history")).runs); })}>刷新历史</button>
          <p className="help">历史手动保留。后台重启会中断未完成运行；重新运行会建立新副本和审核。</p>
          <label className="scope-row"><input type="checkbox" checked={acknowledgeDeletion} onChange={e => setAcknowledgeDeletion(e.target.checked)} />我理解删除历史会同时删除备份并失去撤销能力。</label>
          <div className="history-list">{history.map(item => <div key={item.id}>
            <strong>{item.name}</strong><small>{new Date(item.createdAt).toLocaleString("zh-CN")} · {statuses[item.status]} · {applicationStatuses[item.applicationStatus]}</small>
            <button disabled={busy || Boolean(running)} onClick={() => action(async () => { setRun(await api(`/api/history/${item.id}`, "POST", {})); })}>查看</button>
            <button disabled={busy || Boolean(running) || !acknowledgeDeletion} onClick={() => action(async () => {
              await api(`/api/history/${item.id}`, "DELETE", { acknowledgeLossOfUndo: true });
              setHistory(old => old.filter(h => h.id !== item.id));
              if (run?.id === item.id) { setRun(undefined); localStorage.removeItem("simple-workflow-last-run"); }
              setNotice("历史及备份已删除。");
            })}>删除历史与备份</button>
          </div>)}</div>
        </aside>
      </main>
      <section className="execution">
        <div className="execution-toolbar">
          <div className="result-tabs">
            {(["events", "results", "diff"] as const).map((tab) => (
              <button
                className={view === tab ? "active" : ""}
                key={tab}
                onClick={() => setView(tab)}
              >
                {tab === "events"
                  ? "执行记录"
                  : tab === "results"
                    ? "节点输入 / 输出"
                    : "最终差异 / 各轮"}
              </button>
            ))}
          </div>
          <span className="run-state">
            {run
              ? `${statuses[run.status]} · 修复 ${run.round}/${run.maxRounds} 轮`
              : "尚未运行"}
          </span>
          <div className="toolbar-buttons">
            {run && (
              <>
                <button
                  disabled={!running || busy}
                  onClick={() =>
                    action(async () => {
                      const snapshot = await api(
                        `/api/runs/${run.id}/cancel`,
                        "POST",
                        {},
                      );
                      setRun((current) => newestSnapshot(current, snapshot));
                    })
                  }
                >
                  取消运行
                </button>
                <button disabled={Boolean(running) || busy} onClick={() => action(async () => { setRun(await api(`/api/runs/${run.id}/retry`, "POST", { requestId: crypto.randomUUID() })); })}>重新运行</button>
                {run.mode === "real" && run.changes?.length ? <button disabled={Boolean(running) || busy || !["passed", "issues_remaining"].includes(run.reviewConclusion ?? run.conclusion ?? "") || ["applied", "undone"].includes(run.applicationStatus)} onClick={() => action(async () => { setRun(await api(`/api/runs/${run.id}/apply`, "POST", { version: run.currentVersion })); })}>确认应用最终差异</button> : null}
                {run.applicationStatus === "applied" && <button disabled={busy} onClick={() => action(async () => { setRun(await api(`/api/runs/${run.id}/undo`, "POST", {})); })}>撤销本次应用</button>}
                <a className="button-link" href={`/api/runs/${run.id}/report`}>
                  Markdown
                </a>
                <a
                  className="button-link"
                  href={`/api/runs/${run.id}/report?format=json`}
                >
                  JSON
                </a>
              </>
            )}
          </div>
        </div>
        {approval && (
          <div className="approval-box">
            <div>
              <strong>等待逐次审核 · {run?.mode === "real" ? "本机执行" : "合成请求"}</strong>
              <code>
                {approval.executable} {JSON.stringify(approval.args)}
              </code>
              <p>
                节点 {approval.nodeId} · 第 {approval.round} 轮 · 版本{" "}
                {approval.version} · 目录 {approval.cwd}
              </p>
              <p>
                {approval.purpose} · 预计产物：{approval.artifacts.join(", ")}
              </p>
              <small>
                环境：{approval.environment}
                {run?.mode === "real" ? "；本机执行，未启用文件与网络隔离。命令可能访问宿主文件与网络。" : "；批准仅生成合成记录，不启动进程。"}内容哈希：
                {approval.displayHash}
              </small>
            </div>
            <div className="approval-actions">
              {(["rejected", "approved"] as const).map((decision) => (
                <button
                  className={decision === "approved" ? "primary" : ""}
                  key={decision}
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      const snapshot = await api(
                        `/api/runs/${run!.id}/approval`,
                        "POST",
                        {
                          id: approval.id,
                          displayHash: approval.displayHash,
                          decision,
                        },
                      );
                      setRun((current) => newestSnapshot(current, snapshot));
                    })
                  }
                >
                  {decision === "approved" ? run?.mode === "real" ? "批准本次命令" : "批准演练检查" : "拒绝"}
                </button>
              ))}
            </div>
          </div>
        )}
        {run?.conclusion && (
          <div className={`conclusion conclusion-${run.conclusion}`}>
            <strong>{conclusions[run.conclusion]} · {run.mode === "real" ? "真实运行" : "合成结果"}</strong>
            <span>{run.exitReason}</span>
            <span>文件：{applicationStatuses[run.applicationStatus]}{run.applicationError ? ` · ${run.applicationError}` : ""}</span>
          </div>
        )}
        <div className="execution-body">
          {!run ? (
            <div className="empty-state">
              <span>▷</span>
              <strong>流程已就绪，等待运行</strong>
              <p>打开项目并勾选范围，检查流程后启动真实运行；也可选择合成场景演练。</p>
            </div>
          ) : view === "events" ? (
            <div className="event-list">
              {run.events.map((event) => (
                <div key={event.seq}>
                  <span className="event-seq">
                    {String(event.seq).padStart(2, "0")}
                  </span>
                  <time>
                    {new Date(event.time).toLocaleTimeString("zh-CN", {
                      hour12: false,
                    })}
                  </time>
                  <code>{event.nodeId ?? "workflow"}</code>
                  <span>{event.message}</span>
                </div>
              ))}
            </div>
          ) : view === "results" ? (
            <div className="node-records">
              {nodeRecords.length ? (
                nodeRecords.map((record) => (
                  <details key={record.id} open>
                    <summary>
                      {record.nodeId} · 第 {record.round} 轮 · {record.status} ·
                      输入版本 {record.inputVersion}
                    </summary>
                    <pre>
                      {JSON.stringify(
                        {
                          input: record.input,
                          output: record.output,
                          error: record.error,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                ))
              ) : (
                <p className="help">选中节点尚无执行记录。</p>
              )}
            </div>
          ) : (
            <div className="diff-list">
              {run.mode === "real" && <details open><summary>最终整批差异 · {run.currentVersion}</summary><pre>{JSON.stringify(run.changes ?? [], null, 2)}</pre></details>}
              {changes.length ? (
                changes.map((change, i) => (
                  <div key={i}>
                    <strong>
                      {change.path} · 第 {change.round} 轮 · {run.mode === "real" ? "副本差异" : "合成差异"}
                    </strong>
                    <pre className="diff-before">
                      − {change.before ?? "（原先不存在）"}
                    </pre>
                    <pre className="diff-after">
                      + {change.after ?? "（删除）"}
                    </pre>
                  </div>
                ))
              ) : (
                <p className="help">尚无修复差异。</p>
              )}
            </div>
          )}
        </div>
      </section>
      <footer className="statusbar" role="status">
        <span>{notice}</span>
        <span>Workflow format v1</span>
      </footer>
    </div>
  );
}
export default function WorkflowStudio() {
  return (
    <ReactFlowProvider>
      <Studio />
    </ReactFlowProvider>
  );
}
