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
import { createTemplate } from "@/lib/workflow/templates";
import {
  workflowSchema,
  type RunState,
  type Workflow,
  type WorkflowNode,
} from "@/lib/workflow/schema";
import { validateWorkflow } from "@/lib/workflow/validate";
import {
  conclusions,
  statuses,
  applicationStatuses,
} from "@/lib/workflow/report";
import { WorkflowCard, type CanvasNode } from "./workflow-node";
import { NodeConfig } from "./node-config";
import { newestSnapshot } from "@/lib/workflow/snapshot";
import { WorkspacePanel } from "./workspace-panel";
import { HistoryPanel } from "./history-panel";
import { ExecutionPanel } from "./execution-panel";
import { ApprovalPanel } from "./approval-panel";
import { RunSettings } from "./run-settings";
import { Icon } from "./studio-ui";
import { ThemeSelect, useResolvedTheme } from "./theme-select";
import { cx } from "./studio-styles";
import { useDrawerFocus } from "./use-drawer-focus";
import type {
  Workspace,
  DirectoryBrowse,
  ScopeSelection,
  HistoryEntry,
} from "./studio-types";

const nodeTypes = { workflow: WorkflowCard };
const canvasLabels = {
  "controls.ariaLabel": "画布控件",
  "controls.zoomIn.ariaLabel": "放大画布",
  "controls.zoomOut.ariaLabel": "缩小画布",
  "controls.fitView.ariaLabel": "适应全部节点",
  "minimap.ariaLabel": "工作流缩略图",
};
const activeStatuses = [
  "pending",
  "running",
  "awaiting_approval",
  "finalizing",
];
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
  const theme = useResolvedTheme();
  const [workflow, setWorkflow] = useState<Workflow>(() => createTemplate());
  const [selectedId, select] = useState("review");
  const [selectedEdge, selectEdge] = useState<string>();
  const [measurements, setMeasurements] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const [csrf, setCsrf] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [acknowledgeDeletion, setAcknowledgeDeletion] = useState(false);
  const [modelConfigured, setModelConfigured] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspace, setWorkspace] = useState<Workspace>();
  const [selection, setSelection] = useState<ScopeSelection[]>([]);
  const [excludes, setExcludes] = useState<string>();
  const [browse, setBrowse] = useState<DirectoryBrowse>();
  const [run, setRun] = useState<RunState>();
  const [repairMode, setRepairMode] = useState<"confirm" | "automatic">(
    "confirm",
  );
  const [notice, setNotice] = useState("就绪");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"events" | "results" | "diff">("events");
  const [page, setPage] = useState<"editor" | "history">("editor");
  const [leftTab, setLeftTab] = useState<"workspace" | "nodes">("workspace");
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [noticeError, setNoticeError] = useState(false);
  const leftRef = useRef<HTMLElement>(null);
  const rightRef = useRef<HTMLElement>(null);
  const runDockRef = useRef<HTMLDivElement>(null);
  useDrawerFocus(leftRef, leftOpen, "(max-width: 1199px)", () =>
    setLeftOpen(false),
  );
  useDrawerFocus(rightRef, rightOpen, "(max-width: 767px)", () =>
    setRightOpen(false),
  );
  useDrawerFocus(runDockRef, expanded, "(max-width: 767px)", () =>
    setExpanded(false),
  );
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
            let response = await fetch(
              `/api/runs/${encodeURIComponent(lastId)}`,
              { cache: "no-store" },
            );
            if (response.status === 404)
              response = await fetch(
                `/api/history/${encodeURIComponent(lastId)}`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "x-workflow-csrf": data.csrfToken,
                  },
                  body: "{}",
                },
              );
            if (response.ok && !disposed) {
              const restored: RunState = await response.json();
              setRun((current) => current ?? restored);
              setNotice(
                "已恢复上次运行显示；不会自动重放模型请求、命令或文件应用。",
              );
            }
          }
        }
      })
      .catch((error) => {
        if (!disposed) {
          setNoticeError(true);
          setNotice(error.message);
        }
      });
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    if (!runId) return;
    localStorage.setItem("simple-workflow-last-run", runId);
    let pendingApprovalId: string | undefined;
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.addEventListener("snapshot", (event) => {
      const state: RunState = JSON.parse(event.data);
      const pending = state.approvals.find((a) => a.status === "pending");
      if (pending && pending.id !== pendingApprovalId) {
        setLeftOpen(false);
        setRightOpen(false);
        setExpanded(true);
      }
      pendingApprovalId = pending?.id;
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
  async function api<T = unknown>(
    url: string,
    method = "GET",
    value?: unknown,
  ) {
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
    return result as T;
  }
  async function action(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setNoticeError(false);
    try {
      await work();
    } catch (error) {
      setNoticeError(true);
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
          ? "var(--loop)"
          : validation.errors.some((e) => e.edgeId === edge.id)
            ? "var(--danger)"
            : "var(--edge)",
    },
  }));
  function openSettings() {
    setExpanded(false);
    setPage("editor");
    setSettingsOpen(true);
    setLeftOpen(false);
    setRightOpen(true);
  }
  async function startRun() {
    await action(async () => {
      setRun(
        await api<RunState>(
          "/api/runs",
          "POST",
          {
            mode: "real",
            workflow,
            workspaceId: workspace!.id,
            selection,
            repairMode,
            requestId: crypto.randomUUID(),
          },
        ),
      );
      setView("events");
      setExpanded(true);
      setRightOpen(false);
      setNotice("运行已启动。");
    });
  }
  const actions = { csrf, busy, action, api, setNotice };
  return (
    <div className={cx("studio")}>
      <header className={cx("topbar")}>
        <div className={cx("brand-mark")}>
          <Icon name="workflow" />
        </div>
        <div className={cx("brand")}>
          <strong>Simple Workflow</strong>
          <span>本地多 Agent 工作台</span>
        </div>
        <nav className={cx("main-nav")} aria-label="主导航">
          <button
            aria-current={page === "editor" ? "page" : undefined}
            className={cx(page === "editor" ? "active" : "")}
            onClick={() => {
              setPage("editor");
              setLeftOpen(false);
              setRightOpen(false);
            }}
          >
            <Icon name="workflow" />
            流程编辑
          </button>
          <button
            aria-current={page === "history" ? "page" : undefined}
            className={cx(page === "history" ? "active" : "")}
            onClick={() => {
              setPage("history");
              setLeftOpen(false);
              setRightOpen(false);
            }}
          >
            <Icon name="history" />
            运行历史
          </button>
        </nav>
        <div className={cx("topbar-spacer")} />
        <ThemeSelect />
        <button className={cx("primary")} onClick={openSettings}>
          <Icon name="play" />
          运行设置
        </button>
      </header>
      <main className={cx("main-content")}>
        <div className={cx("workbench")} hidden={page !== "editor"}>
          {leftOpen && (
            <button
              className={cx("drawer-backdrop left-backdrop")}
              aria-hidden="true"
              data-dialog-backdrop="true"
              aria-label="关闭资源面板"
              tabIndex={-1}
              onClick={() => setLeftOpen(false)}
            />
          )}
          <aside
            ref={leftRef}
            className={cx(`workspace panel ${leftOpen ? "drawer-open" : ""}`)}
            aria-label="资源面板"
          >
            <div className={cx("drawer-heading")}>
              <h2>资源面板</h2>
              <button
                className={cx("icon-button")}
                aria-label="关闭资源面板"
                onClick={() => setLeftOpen(false)}
              >
                <Icon name="close" />
              </button>
            </div>
            <WorkspacePanel
              {...actions}
              tab={leftTab}
              setTab={setLeftTab}
              workspacePath={workspacePath}
              setWorkspacePath={setWorkspacePath}
              workspace={workspace}
              setWorkspace={setWorkspace}
              selection={selection}
              setSelection={setSelection}
              excludes={excludes}
              setExcludes={setExcludes}
              browse={browse}
              setBrowse={setBrowse}
              workflow={workflow}
              setWorkflow={setWorkflow}
              select={select}
              onAdded={() => {
                setLeftOpen(false);
                setSettingsOpen(false);
              }}
            />
          </aside>
          <section className={cx("canvas-section")}>
            <div className={cx("canvas-toolbar")}>
              <button
                className={cx("icon-button mobile-left")}
                aria-label="打开资源面板"
                onClick={() => {
                  setRightOpen(false);
                  setLeftOpen(true);
                }}
              >
                <Icon name="sidebar" />
              </button>
              <div>
                <span className={cx("eyebrow")}>WORKFLOW</span>
                <input
                  className={cx("workflow-name")}
                  aria-label="工作流名称"
                  value={workflow.name}
                  onChange={(e) =>
                    setWorkflow({ ...workflow, name: e.target.value })
                  }
                />
              </div>
              <div className={cx("toolbar-buttons canvas-actions")}>
                <button
                  className={cx("mobile-right")}
                  aria-label="打开节点配置"
                  onClick={() => {
                    setLeftOpen(false);
                    setSettingsOpen(false);
                    setRightOpen(true);
                  }}
                >
                  <Icon name="sliders" />
                  配置
                </button>
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
                      setNotice("工作流已保存。");
                    })
                  }
                >
                  保存
                </button>
                <button
                  disabled={!csrf || busy}
                  onClick={() =>
                    action(async () => {
                      const result = await api<{ workflow: Workflow | null }>(
                        "/api/workflows",
                      );
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
                          parsed.errors
                            .map((error) => error.message)
                            .join("；"),
                        );
                      setWorkflow(parsed.workflow!);
                      select(parsed.workflow!.nodes[0].id);
                      setNotice("工作流已导入。");
                    });
                    e.target.value = "";
                  }}
                />
              </div>
            </div>
            <div className={cx("canvas")}>
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
                  setSettingsOpen(false);
                }}
                onEdgeClick={(_, edge) => selectEdge(edge.id)}
                fitView
                minZoom={0.2}
                maxZoom={1.5}
                colorMode={theme}
                ariaLabelConfig={canvasLabels}
                aria-label="工作流画布"
              >
                <Background color="var(--canvas-dot)" gap={22} size={1} />
                <Controls showInteractive={false} />
                <MiniMap
                  pannable
                  zoomable
                  nodeColor="var(--minimap-node)"
                  maskColor="var(--minimap-mask)"
                />
              </ReactFlow>
            </div>
            <div
              className={cx(
                `validation-bar ${validation.valid ? "valid" : "has-errors"}`,
              )}
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
              <div className={cx("validation-errors")}>
                {validation.errors.map((error, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      if (error.nodeId) {
                        select(error.nodeId);
                        setSettingsOpen(false);
                      }
                      if (error.edgeId) selectEdge(error.edgeId);
                    }}
                  >
                    {error.nodeId || error.edgeId || "流程"} · {error.message}
                  </button>
                ))}
              </div>
            )}
          </section>

          {rightOpen && (
            <button
              className={cx("drawer-backdrop right-backdrop")}
              aria-hidden="true"
              data-dialog-backdrop="true"
              aria-label="关闭配置面板"
              tabIndex={-1}
              onClick={() => setRightOpen(false)}
            />
          )}
          <aside
            ref={rightRef}
            className={cx(
              `configuration panel ${rightOpen ? "drawer-open" : ""}`,
            )}
            aria-label="配置面板"
          >
            <div className={cx("panel-title")}>
              <h2>
                <Icon name={settingsOpen ? "play" : "sliders"} />
                {settingsOpen ? "运行设置" : "节点配置"}
              </h2>
              <button
                className={cx(
                  `icon-button ${settingsOpen ? "" : "desktop-hidden"}`,
                )}
                aria-label={settingsOpen ? "返回节点配置" : "关闭配置面板"}
                onClick={() => {
                  if (settingsOpen) setSettingsOpen(false);
                  else setRightOpen(false);
                }}
              >
                <Icon name={settingsOpen ? "back" : "close"} />
              </button>
            </div>
            <div hidden={settingsOpen}>
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
                        (e) =>
                          e.source !== selected.id && e.target !== selected.id,
                      ),
                    }));
                    select("");
                  }}
                />
              ) : (
                <p className={cx("help")}>点击画布上的节点查看配置。</p>
              )}
            </div>
            <div hidden={!settingsOpen}>
              <RunSettings
                repairMode={repairMode}
                setRepairMode={setRepairMode}
                csrf={csrf}
                busy={busy}
                running={Boolean(running)}
                valid={validation.valid}
                modelConfigured={modelConfigured}
                workspace={workspace}
                selectionCount={selection.length}
                onStart={startRun}
                onWorkspace={() => {
                  setLeftTab("workspace");
                  setRightOpen(false);
                  setLeftOpen(true);
                }}
              />
            </div>
          </aside>
        </div>
        {page === "history" && (
          <HistoryPanel
            {...actions}
            history={history}
            setHistory={setHistory}
            acknowledgeDeletion={acknowledgeDeletion}
            setAcknowledgeDeletion={setAcknowledgeDeletion}
            running={Boolean(running)}
            run={run}
            setRun={setRun}
            onView={() => {
              setExpanded(true);
              setView("events");
            }}
          />
        )}
      </main>
      <div ref={runDockRef} className={cx("run-dock")} aria-label="运行与审核">
        <ApprovalPanel {...actions} run={run} setRun={setRun} />
        <ExecutionPanel
          {...actions}
          run={run}
          setRun={setRun}
          running={Boolean(running)}
          selectedId={selectedId}
          view={view}
          setView={setView}
          expanded={expanded}
          setExpanded={setExpanded}
          onSettings={openSettings}
        />
      </div>
      <footer className={cx(`statusbar ${noticeError ? "notice-error" : ""}`)}>
        <span role={noticeError ? "alert" : "status"}>
          <Icon name={noticeError ? "alert" : busy ? "activity" : "check"} />
          {busy ? "正在处理…" : notice}
        </span>
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
