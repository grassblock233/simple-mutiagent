"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type SetStateAction,
} from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useNodesInitialized,
  MarkerType,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import {
  createTemplate,
  outputPortLabel,
} from "@/lib/workflow/templates";
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
import { useStudioLayout } from "./use-studio-layout";
import { draftKey, readDraft, persistDraft, saveBeforeReplace, workflowFingerprint, executionKey, hasPendingJson, type DraftData, type JsonBuffer } from "@/lib/studio/draft";
import { openWorkspace } from "@/lib/studio/workspace-stream";
import { defaultLayout } from "@/lib/studio/layout";
import { PanelResizer } from "./panel-resizer";
import { WelcomePanel } from "./welcome-panel";
import type {
  Workspace,
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
function FitCanvas({ visible }: { visible: boolean }) {
  const { fitView } = useReactFlow();
  const initialized = useNodesInitialized();
  const fitted = useRef(false);
  useEffect(() => {
    if (!visible || !initialized || fitted.current) return;
    const frame = requestAnimationFrame(() => {
      void fitView({ padding: 0.18 });
      fitted.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, initialized, fitView]);
  return null;
}

function Studio() {
  const theme = useResolvedTheme();
  const { layout, setLayout, width, height } = useStudioLayout();
  const { leftOpen, rightOpen, expanded } = layout;
  const setLeftOpen = useCallback(
    (value: SetStateAction<boolean>) =>
      setLayout((old) => ({
        ...old,
        activeSide: "left",
        leftOpen: typeof value === "function" ? value(old.leftOpen) : value,
      })),
    [setLayout],
  );
  const setRightOpen = useCallback(
    (value: SetStateAction<boolean>) =>
      setLayout((old) => ({
        ...old,
        activeSide: "right",
        rightOpen: typeof value === "function" ? value(old.rightOpen) : value,
      })),
    [setLayout],
  );
  const setExpanded = useCallback(
    (value: SetStateAction<boolean>) =>
      setLayout((old) => ({
        ...old,
        expanded: typeof value === "function" ? value(old.expanded) : value,
      })),
    [setLayout],
  );
  const [canvasRevision, setCanvasRevision] = useState(0);
  const [draftWorkflow, setDraftWorkflow] = useState<Workflow>(() => createTemplate());
  const [draftId, setDraftId] = useState("initial");
  const [revision, setRevision] = useState(0);
  const [buffers, setBuffers] = useState<Record<string, JsonBuffer>>({});
  const [savedFingerprint, setSavedFingerprint] = useState("");
  const [runBinding, setRunBinding] = useState<DraftData["runBinding"]>();
  const [snapshotView, setSnapshotView] = useState(false);
  const [undoDraft, setUndoDraft] = useState<DraftData>();
  const [replacement, setReplacement] = useState<{workflow:Workflow;selected:string;saved:boolean}>();
  const [hydrated, setHydrated] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const [localSaved, setLocalSaved] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoredRoot, setRestoredRoot] = useState<string>();
  const [restoreRequest, setRestoreRequest] = useState<{root:string;excludes?:string}>();
  const [restoreStats, setRestoreStats] = useState<import("@/lib/workspace-rules").ScanStats>();
  const restoreAbort = useRef<AbortController | null>(null);
  const setWorkflow = useCallback((value: SetStateAction<Workflow>) => {
    setDraftWorkflow(value); setRevision(old=>old+1); setLocalSaved(false);
  }, []);
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
  const [run, setRun] = useState<RunState>();
  const [repairMode, setRepairMode] = useState<"confirm" | "automatic">(
    "confirm",
  );
  const [notice, setNotice] = useState("就绪");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"events" | "results" | "diff">("events");
  const [page, setPage] = useState<"welcome" | "editor" | "history">("welcome");
  const [leftTab, setLeftTab] = useState<"workspace" | "nodes">("workspace");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [noticeError, setNoticeError] = useState(false);
  const leftRef = useRef<HTMLElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const workflow = snapshotView && run ? run.workflow : draftWorkflow;
  const pendingJson = hasPendingJson(draftWorkflow,buffers);
  const dirty = workflowFingerprint(draftWorkflow) !== savedFingerprint || pendingJson;
  const currentExecutionKey = executionKey(draftWorkflow,workspace?.root,excludes,selection,repairMode);
  const matchesRun = Boolean(run && runBinding?.runId === run.id && runBinding.draftId === draftId && runBinding.revision === revision && runBinding.executionKey === currentExecutionKey && !pendingJson);
  const draftData: DraftData = {id:draftId,revision,workflow:draftWorkflow,workspacePath,openedRoot:workspace?.root ?? restoredRoot,excludes,selection,repairMode,selectedId,buffers,savedFingerprint,runBinding};
  const draftRef = useRef(draftData);
  const undoRef = useRef(undoDraft);
  useLayoutEffect(() => { draftRef.current = draftData; undoRef.current = undoDraft; });
  function restoreDraft(data:DraftData) {
    restoreAbort.current?.abort();
    setWorkspace(undefined);
    setRestoreStats(undefined);
    setRestoreRequest(data.openedRoot ? {root:data.openedRoot,excludes:data.excludes} : undefined);
    setRestoredRoot(data.openedRoot); setDraftId(data.id); setRevision(data.revision); setDraftWorkflow(data.workflow); setWorkspacePath(data.workspacePath); setExcludes(data.excludes); setSelection(data.selection); setRepairMode(data.repairMode); select(data.selectedId); setBuffers(data.buffers); setSavedFingerprint(data.savedFingerprint); setRunBinding(data.runBinding); setSnapshotView(false);
  }
  useEffect(()=>{
    const frame=requestAnimationFrame(()=>{
      try { const restored=readDraft(localStorage.getItem(draftKey)); if(restored){restoreDraft(restored.data);setUndoDraft(restored.undo);setNotice("已恢复本地草稿；运行不会自动重放。");}else setDraftId(crypto.randomUUID()); }
      catch { setStorageFailed(true); }
      setHydrated(true);
    }); return ()=>cancelAnimationFrame(frame);
  },[]);
  useEffect(()=>{
    if(!hydrated)return;
    const save=()=>{try{const saved=persistDraft(localStorage,draftRef.current,undoRef.current);setLocalSaved(saved);setStorageFailed(!saved);}catch{setStorageFailed(true);setLocalSaved(false);}};
    const timer=setTimeout(save,350);
    const leave=(event:BeforeUnloadEvent)=>{try{localStorage.setItem(draftKey,JSON.stringify({version:1,data:draftRef.current,undo:undoRef.current}));}catch{event.preventDefault();event.returnValue="";}};
    const hide=()=>{try{localStorage.setItem(draftKey,JSON.stringify({version:1,data:draftRef.current,undo:undoRef.current}));}catch{/* beforeunload handles the visible warning */}};
    window.addEventListener("beforeunload",leave);window.addEventListener("pagehide",hide);
    return()=>{clearTimeout(timer);window.removeEventListener("beforeunload",leave);window.removeEventListener("pagehide",hide);};
  },[hydrated,draftWorkflow,draftId,revision,workspacePath,workspace?.root,restoredRoot,excludes,selection,repairMode,selectedId,buffers,savedFingerprint,runBinding,undoDraft]);
  useEffect(() => {
    if (!csrf || !hydrated || !restoreRequest) return;
    const abort = new AbortController();
    restoreAbort.current = abort;
    const frame = requestAnimationFrame(() => {
      setRestoring(true);
      void openWorkspace(restoreRequest.root, restoreRequest.excludes?.split("\n").filter(Boolean), csrf, abort.signal, setRestoreStats)
        .then(next => {
          if (abort.signal.aborted) return;
          setWorkspace(next);
          setSelection(old => old.filter(item => next.files.some(p => p === item.path || (item.directory && p.startsWith(item.path + "/")))));
        })
        .catch(error => {
          if (!abort.signal.aborted) {
            setNoticeError(true);
            setNotice("草稿已恢复，但项目需重新打开：" + error.message);
          }
        })
        .finally(() => { if (!abort.signal.aborted) setRestoring(false); });
    });
    return () => { cancelAnimationFrame(frame); abort.abort(); };
  }, [csrf, hydrated, restoreRequest]);
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
          let lastId: string | null = null;
          try {
            lastId = localStorage.getItem("simple-workflow-last-run");
          } catch {
            /* Storage is optional. */
          }
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
    try {
      localStorage.setItem("simple-workflow-last-run", runId);
    } catch {
      /* Keep the live connection without persistence. */
    }
    let pendingApprovalId: string | undefined;
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.addEventListener("snapshot", (event) => {
      const state: RunState = JSON.parse(event.data);
      const pending = state.approvals.find((a) => a.status === "pending");
      if (pending && pending.id !== pendingApprovalId) {
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
  }, [runId, setExpanded]);
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
    if(snapshotView)return;
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
    if(snapshotView)return;
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
    if(snapshotView)return;
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
          status: snapshotView || matchesRun ? run?.records.findLast((r) => r.nodeId === node.id)?.status : undefined,
          invalid: validation.errors.some((e) => e.nodeId === node.id),
        },
      })),
    [workflow.nodes, selectedId, run, validation.errors, measurements,snapshotView,matchesRun],
  );
  const edges = workflow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourcePort,
    targetHandle: "in",
    type: "smoothstep",
    selected: selectedEdge === edge.id,
    label:
      edge.sourcePort === "next"
        ? undefined
        : outputPortLabel(
            workflow.nodes.find((node) => node.id === edge.source),
            edge.sourcePort,
          ),
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
    setPage("editor");
    setSettingsOpen(true);
    setRightOpen(true);
  }
  async function startRun() {
    await action(async () => {
      if(pendingJson)throw new Error("请先应用或重置未应用的节点 JSON");
      const started = await api<RunState>("/api/runs", "POST", {
        mode:"real",workflow:draftWorkflow,workspaceId:workspace!.id,selection,repairMode,requestId:crypto.randomUUID(),
      });
      setRun(started);setRunBinding({runId:started.id,draftId,revision,executionKey:currentExecutionKey});setSnapshotView(false);
      setView("events");
      setExpanded(true);
      setNotice("运行已启动。");
    });
  }
  const actions = { csrf, busy, action, api, setNotice };
  const showLeft = page === "editor" && leftOpen;
  const showRight = page === "editor" && rightOpen;
  const mobileViewport = width < 768;
  function openProject() {
    setPage("editor");
    setLeftTab("workspace");
    setLeftOpen(true);
    requestAnimationFrame(() =>
      leftRef.current?.querySelector<HTMLInputElement>("input")?.focus(),
    );
  }
  function commitReplacement(next:Workflow,selected:string,saved=false) {
    setUndoDraft(structuredClone(draftRef.current));
    setDraftWorkflow(next);setDraftId(crypto.randomUUID());setRevision(0);setBuffers({});setSnapshotView(false);setSavedFingerprint(saved?workflowFingerprint(next):"");setLocalSaved(false);
    select(selected);selectEdge(undefined);setMeasurements({});setCanvasRevision(r=>r+1);setReplacement(undefined);
  }
  function replaceWorkflow(next:Workflow,selected=next.nodes[0].id,saved=false) {
    if(dirty){setReplacement({workflow:next,selected,saved});return;}
    commitReplacement(next,selected,saved);
  }
  async function saveWorkflow() {
    if(pendingJson)throw new Error("请先应用或重置未应用的节点 JSON");
    const saving=draftWorkflow;await api("/api/workflows","PUT",saving);setSavedFingerprint(workflowFingerprint(saving));setNotice("工作流已保存到服务器。");
  }
  function loadTemplate() {
    replaceWorkflow(createTemplate(),"review");setSettingsOpen(false);setPage("editor");setRightOpen(true);
  }
  function resource(tab: "workspace" | "nodes") {
    setLeftOpen(page === "editor" && leftTab === tab ? !leftOpen : true);
    setLeftTab(tab);
    setPage("editor");
  }
  return (
    <div
      className={cx("studio")}
      style={{ "--result-height": `${layout.resultHeight}px` } as CSSProperties}
    >
      <header className={cx("topbar")} inert={mobileViewport || Boolean(replacement)}>
        <button
          className={cx("brand-mark")}
          aria-label="返回欢迎工作台"
          title="欢迎工作台"
          onClick={() => setPage("welcome")}
        >
          <Icon name="workflow" />
        </button>
        <div className={cx("brand")}>
          <strong>Simple Workflow</strong>
        </div>
        <span className={cx("topbar-divider")}>/</span>
        <span className={cx("page-title")}>
          {page === "welcome"
            ? "欢迎工作台"
            : page === "editor"
              ? "流程编辑"
              : "运行历史"}
        </span>
        {page !== "editor" && (
          <button
            className={cx("topbar-editor")}
            onClick={() => setPage("editor")}
          >
            <Icon name="workflow" />
            流程编辑
          </button>
        )}
        <div className={cx("topbar-spacer")} />
        <button
          className={cx("icon-button")}
          aria-label="切换资源面板"
          title="切换资源面板"
          aria-pressed={showLeft}
          onClick={() => {
            setPage("editor");
            setLeftOpen(!showLeft);
          }}
        >
          <Icon name="sidebar" />
        </button>
        <button
          className={cx("icon-button")}
          aria-label="切换配置面板"
          title="切换配置面板"
          aria-pressed={showRight}
          onClick={() => {
            setPage("editor");
            setRightOpen(!showRight);
          }}
        >
          <Icon name="panel-right" />
        </button>
        <button
          className={cx("icon-button")}
          aria-label="重置布局"
          title="重置布局"
          onClick={() => {
            setLayout({ ...defaultLayout });
            setNotice("布局已重置。");
          }}
        >
          <Icon name="monitor" />
        </button>
        <ThemeSelect />
        <button className={cx("primary")} onClick={openSettings}>
          <Icon name="play" />
          运行设置
        </button>
      </header>
      <div
        className={cx("desktop-shell")}
        inert={mobileViewport || Boolean(replacement)}
        style={{
          gridTemplateColumns: `48px ${showLeft ? layout.leftWidth : 0}px ${showLeft ? 5 : 0}px minmax(0, 1fr) ${showRight ? 5 : 0}px ${showRight ? layout.rightWidth : 0}px`,
        }}
      >
        <nav className={cx("activitybar")} aria-label="主导航">
          <button
            title="欢迎工作台"
            aria-label="欢迎工作台"
            aria-pressed={page === "welcome"}
            onClick={() => setPage("welcome")}
          >
            <Icon name="home" />
          </button>
          <button
            title="项目文件"
            aria-label="项目文件"
            aria-pressed={showLeft && leftTab === "workspace"}
            onClick={() => resource("workspace")}
          >
            <Icon name="folder" />
          </button>
          <button
            title="节点库"
            aria-label="节点库"
            aria-pressed={showLeft && leftTab === "nodes"}
            onClick={() => resource("nodes")}
          >
            <Icon name="layers" />
          </button>
          <button
            title="运行历史"
            aria-label="运行历史"
            aria-pressed={page === "history"}
            onClick={() => setPage("history")}
          >
            <Icon name="history" />
          </button>
          <div className={cx("activitybar-spacer")} />
          <button
            title="运行设置"
            aria-label="运行设置"
            aria-pressed={showRight && settingsOpen}
            onClick={openSettings}
          >
            <Icon name="sliders" />
          </button>
        </nav>
        <aside
          ref={leftRef}
          className={cx("workspace panel")}
          aria-label="资源面板"
          hidden={!showLeft}
        >
          <div className={cx("panel-title")}>
            <h2>{leftTab === "workspace" ? "项目文件" : "节点库"}</h2>
            <button
              className={cx("icon-button")}
              aria-label="关闭资源面板"
              title="关闭资源面板"
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
            workflow={draftWorkflow}
            setWorkflow={setWorkflow}
            restoring={restoring}
            restoreStats={restoreStats}
            onCancelRestore={()=>{restoreAbort.current?.abort();setRestoring(false);setNotice("项目恢复扫描已取消；草稿与范围保留，可重新打开项目。");}}
            readOnly={snapshotView}
            select={select}
            onOpened={(next) => { restoreAbort.current?.abort(); setRestoring(false); setRestoreRequest(undefined); setRestoredRoot(next.root); setRestoreStats(undefined); setPage("editor"); }}
            onAdded={() => {
              setSettingsOpen(false);
              setRightOpen(true);
            }}
          />
        </aside>
        <div className={cx("left-divider")} hidden={!showLeft}>
          <PanelResizer
            label="调整资源面板宽度"
            value={layout.leftWidth}
            min={220}
            max={Math.min(
              420,
              Math.max(
                220,
                width - 48 - 10 - 400 - (showRight ? layout.rightWidth : 0),
              ),
            )}
            onChange={(leftWidth) =>
              setLayout((old) => ({ ...old, leftWidth }))
            }
          />
        </div>
        <div className={cx("center-stack")}>
          <main className={cx("main-content")}>
            {page === "welcome" && (
              <WelcomePanel
                onProject={openProject}
                onTemplate={loadTemplate}
                onHistory={() => setPage("history")}
                onContinue={() => setPage("editor")}
                workspace={workspace?.root}
              />
            )}
            <section
              className={cx("canvas-section")}
              hidden={page !== "editor"}
              aria-label="流程编辑"
            >
              <div className={cx("canvas-toolbar")}>
                <div>
                  <input
                    className={cx("workflow-name")}
                    aria-label="工作流名称"
                    readOnly={snapshotView}
                    value={workflow.name}
                    onChange={(e) =>
                      setWorkflow({ ...workflow, name: e.target.value })
                    }
                  />
                </div>
                <div className={cx("toolbar-buttons canvas-actions")}>
                  <span className={cx("draft-state")} role="status">{storageFailed?"本地存储不可用，离开前请导出或保存":pendingJson?"有未应用 JSON · "+(localSaved?"本地草稿已保存":"正在保存本地草稿"):!dirty?"已保存到服务器":localSaved?"有未保存修改 · 本地草稿已保存":"有未保存修改"}</span>
                  {run && <button aria-pressed={snapshotView} onClick={()=>{setSnapshotView(v=>!v);setCanvasRevision(r=>r+1);}}>{snapshotView?"返回当前草稿":"查看运行快照"}</button>}
                  {undoDraft && <button onClick={()=>{restoreDraft(undoDraft);setUndoDraft(undefined);setCanvasRevision(r=>r+1);}}>撤销替换</button>}
                  <button onClick={loadTemplate}>加载默认模板</button>
                  <button
                    disabled={!csrf || busy || !validation.valid || pendingJson || snapshotView}
                    onClick={() =>
                      action(async () => {
                        await saveWorkflow();
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
                          replaceWorkflow(result.workflow, result.workflow.nodes[0].id, true);
                          setNotice("已加载保存的工作流。");
                        } else setNotice("尚无已保存工作流。");
                      })
                    }
                  >
                    加载
                  </button>
                  <button onClick={() => importRef.current?.click()}>
                    导入
                  </button>
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
                        replaceWorkflow(parsed.workflow!);
                        setNotice("工作流已导入。");
                      });
                      e.target.value = "";
                    }}
                  />
                </div>
              </div>
              <div className={cx("canvas")}>
                <ReactFlowProvider key={canvasRevision}>
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    nodesDraggable={!snapshotView}
                    nodesConnectable={!snapshotView}
                    edgesReconnectable={!snapshotView}
                    deleteKeyCode={snapshotView ? null : ["Backspace","Delete"]}
                    onNodesChange={nodeChanges}
                    onEdgesChange={edgeChanges}
                    onConnect={connect}
                    onNodeClick={(_, node) => {
                      select(node.id);
                      selectEdge(undefined);
                      setSettingsOpen(false);
                      setRightOpen(true);
                    }}
                    onEdgeClick={(_, edge) => selectEdge(edge.id)}
                    minZoom={0.2}
                    maxZoom={1.5}
                    colorMode={theme}
                    ariaLabelConfig={canvasLabels}
                    aria-label="工作流画布"
                  >
                    <FitCanvas visible={page === "editor"} />
                    <Background color="var(--canvas-dot)" gap={22} size={1} />
                    <Controls showInteractive={false} />
                    <MiniMap
                      pannable
                      zoomable
                      nodeColor="var(--minimap-node)"
                      maskColor="var(--minimap-mask)"
                    />
                  </ReactFlow>
                </ReactFlowProvider>
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
                {selectedEdge && !snapshotView && (
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
                          setRightOpen(true);
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
          <div className={cx("run-dock")} aria-label="运行与审核">
            <ApprovalPanel {...actions} run={run} setRun={setRun} />
            {expanded && (
              <PanelResizer
                label="调整结果面板高度"
                horizontal
                reverse
                value={layout.resultHeight}
                min={140}
                max={Math.max(140, Math.floor((height - 70) * 0.45))}
                onChange={(resultHeight) =>
                  setLayout((old) => ({ ...old, resultHeight }))
                }
              />
            )}
            <ExecutionPanel
              {...actions}
              run={run}
              setRun={setRun}
              running={Boolean(running)}
              selectedId={selectedId}
              matchesDraft={matchesRun}
              view={view}
              setView={setView}
              expanded={expanded}
              setExpanded={setExpanded}
              onSettings={openSettings}
            />
          </div>
        </div>
        <div className={cx("right-divider")} hidden={!showRight}>
          <PanelResizer
            label="调整配置面板宽度"
            reverse
            value={layout.rightWidth}
            min={240}
            max={Math.min(
              480,
              Math.max(
                240,
                width - 48 - 10 - 400 - (showLeft ? layout.leftWidth : 0),
              ),
            )}
            onChange={(rightWidth) =>
              setLayout((old) => ({ ...old, rightWidth }))
            }
          />
        </div>
        <aside
          hidden={!showRight}
          className={cx("configuration panel")}
          aria-label="配置面板"
        >
          <div className={cx("panel-title")}>
            <h2>
              <Icon name={settingsOpen ? "play" : "sliders"} />
              {settingsOpen ? "运行设置" : "节点配置"}
            </h2>
            <div className={cx("toolbar-buttons")}>
              {settingsOpen && (
                <button
                  className={cx("icon-button")}
                  aria-label="返回节点配置"
                  title="返回节点配置"
                  onClick={() => setSettingsOpen(false)}
                >
                  <Icon name="back" />
                </button>
              )}
              <button
                className={cx("icon-button")}
                aria-label="关闭配置面板"
                title="关闭配置面板"
                onClick={() => setRightOpen(false)}
              >
                <Icon name="close" />
              </button>
            </div>
          </div>
          <fieldset disabled={snapshotView} hidden={settingsOpen} style={{border:0,padding:0,margin:0,minWidth:0}}>
            {selected ? (
              <NodeConfig
                key={selected.id}
                node={selected}
                buffer={snapshotView ? undefined : buffers[selected.id]}
                setBuffer={value=>{setBuffers(old=>({...old,[selected.id]:value}));setLocalSaved(false);}}
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
          </fieldset>
          <div hidden={!settingsOpen}>
            <RunSettings
              repairMode={repairMode}
              setRepairMode={setRepairMode}
              csrf={csrf}
              busy={busy}
              running={Boolean(running)}
              valid={validateWorkflow(draftWorkflow).valid && !pendingJson && !restoring}
              modelConfigured={modelConfigured}
              workspace={workspace}
              selectionCount={selection.length}
              onStart={startRun}
              onWorkspace={() => {
                setLeftTab("workspace");
                setLeftOpen(true);
              }}
            />
          </div>
        </aside>
      </div>
      <footer className={cx(`statusbar ${noticeError ? "notice-error" : ""}`)}>
        <span role={noticeError ? "alert" : "status"}>
          <Icon name={noticeError ? "alert" : busy ? "activity" : "check"} />
          {busy ? "正在处理…" : notice}
        </span>
        <span className={cx("statusbar-meta")}>
          <Icon name="workflow" />
          {workflow.nodes.length} 个节点<span>·</span>
          {workspace ? `${selection.length} 项范围` : "尚未打开项目"}
        </span>
      </footer>
      {replacement && <div className={cx("replacement-dialog")} role="dialog" aria-modal="true" aria-labelledby="replace-title" onKeyDown={event=>{
        if(event.key==="Escape")setReplacement(undefined);
        if(event.key==="Tab") {const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));const first=buttons[0],last=buttons.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
      }}>
        <div><h2 id="replace-title">替换当前草稿？</h2><p>当前有未保存编辑。替换后可以撤销，本地草稿会保留。</p>
          <div className={cx("toolbar-buttons")}><button autoFocus onClick={()=>setReplacement(undefined)}>取消</button>
          <button disabled={busy||pendingJson||!validateWorkflow(draftWorkflow).valid} onClick={()=>action(async()=>{await saveBeforeReplace(saveWorkflow,()=>commitReplacement(replacement.workflow,replacement.selected,replacement.saved));})}>保存后替换</button>
          <button onClick={()=>commitReplacement(replacement.workflow,replacement.selected,replacement.saved)}>直接替换</button></div>
          {pendingJson && <p>存在未应用 JSON，请取消后先应用或重置，再保存到服务器。</p>}
        </div></div>}
      <div
        className={cx("desktop-required")}
        role="status"
        hidden={!mobileViewport}
      >
        <Icon name="monitor" />
        <h2>移动端暂不支持工作台</h2>
        <p>请使用桌面浏览器，或将窗口加宽至 768px 及以上。</p>
        <small>正在进行的任务会继续运行。</small>
      </div>
    </div>
  );
}
export default function WorkflowStudio() {
  return <Studio />;
}
