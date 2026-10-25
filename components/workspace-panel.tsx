"use client";
import { useState, useRef, useEffect, type Dispatch, type SetStateAction } from "react";
import { cx } from "./studio-styles";
import { Icon, EmptyState, handleTabKeys, nodeIcons } from "./studio-ui";
import { DEFAULT_EXCLUDES, type ScanStats } from "@/lib/workspace-rules";
import { openWorkspace } from "@/lib/studio/workspace-stream";
import { ProjectFileTree } from "./project-file-tree";
import { createNode } from "@/lib/workflow/templates";
import { labels, nodeKinds, type Workflow } from "@/lib/workflow/schema";
import type {
  StudioActions,
  Workspace,
  ScopeSelection,
} from "./studio-types";
type Setter<T> = Dispatch<SetStateAction<T>>;

type Props = StudioActions & {
  tab: "workspace" | "nodes";
  setTab: Setter<"workspace" | "nodes">;
  workspacePath: string;
  setWorkspacePath: Setter<string>;
  workspace?: Workspace;
  setWorkspace: Setter<Workspace | undefined>;
  selection: ScopeSelection[];
  setSelection: Setter<ScopeSelection[]>;
  excludes?: string;
  setExcludes: Setter<string | undefined>;
  workflow: Workflow;
  setWorkflow: Setter<Workflow>;
  select: Setter<string>;
  onAdded: () => void;
  onOpened: (workspace: Workspace) => void;
  restoring?: boolean;
  readOnly?: boolean;
  onCancelRestore?: () => void;
  restoreStats?: ScanStats;
};
export function WorkspacePanel({
  tab,
  setTab,
  workspacePath,
  setWorkspacePath,
  workspace,
  setWorkspace,
  selection,
  setSelection,
  excludes,
  setExcludes,
  workflow,
  setWorkflow,
  select,
  onAdded,
  onOpened,
  restoring,
  readOnly,
  onCancelRestore,
  restoreStats,
  csrf,
  busy,
  action,
  api,
  setNotice,
}: Props) {
  const [scan, setScan] = useState<ScanStats>();
  const [scanning, setScanning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function open() {
    const controller = new AbortController(); abort.current = controller; setScanning(true); setScan(undefined);
    try {
      const next = await openWorkspace(workspacePath, excludes?.split("\n").map(s=>s.trim()).filter(Boolean), csrf, controller.signal, setScan);
      setWorkspace(next); onOpened(next); setSelection([]); setExcludes(next.excludes.join("\n")); setNotice("项目已打开，请选择范围。");
    } catch (error) { if(controller.signal.aborted) setNotice("扫描已取消；路径和排除规则已保留。"); else throw error; }
    finally { setScanning(false); abort.current = null; }
  }
  return (
    <>
      <div
        className={cx("panel-tabs")}
        role="tablist"
        onKeyDown={handleTabKeys}
        aria-label="资源面板"
      >
        <button
          role="tab"
          aria-selected={tab === "workspace"}
          onClick={() => setTab("workspace")}
          className={cx(tab === "workspace" ? "active" : "")}
        >
          <Icon name="folder" />
          工作区
        </button>
        <button
          role="tab"
          aria-selected={tab === "nodes"}
          onClick={() => setTab("nodes")}
          className={cx(tab === "nodes" ? "active" : "")}
        >
          <Icon name="layers" />
          节点库
        </button>
      </div>
      <div hidden={tab !== "workspace"} role="tabpanel">
        <label>
          本地项目路径
          <input
            aria-label="本地项目路径"
            placeholder="/home/用户名/project"
            value={workspacePath}
            onChange={(e) => setWorkspacePath(e.target.value)}
          />
        </label>
        <div className={cx("toolbar-buttons")}>
          <button
            disabled={busy || !csrf}
            onClick={() =>
              action(async () => {
                const result = await api<{ path: string | null }>(
                  "/api/workspaces/pick-directory", "POST", { path: workspacePath },
                );
                if (result.path !== null) setWorkspacePath(result.path);
              })
            }
          >
            浏览目录
          </button>
          <button
            disabled={busy || scanning || restoring || !csrf || !workspacePath}
            onClick={() =>
              action(async () => {
                await open();
              })
            }
          >
            打开项目
          </button>
        </div>
        {(scanning || restoring) && <button onClick={()=>restoring ? onCancelRestore?.() : abort.current?.abort()}>取消扫描</button>}
        {(scan ?? restoreStats ?? workspace?.stats) && <div className={cx("scan-status")} role="status">
          已扫描 {(scan ?? restoreStats ?? workspace!.stats!).scanned} 项 · 接收 {(scan ?? restoreStats ?? workspace!.stats!).files} 文件 · {((scan ?? restoreStats ?? workspace!.stats!).bytes/1048576).toFixed(1)} MiB
          {Object.entries((scan ?? restoreStats ?? workspace!.stats!).skipped).map(([reason,count])=><div key={reason}>{reason}：{count}</div>)}
          {(scan ?? restoreStats ?? workspace!.stats!).directories.map(d=><div key={d.path}>{d.path} · {d.files} 文件 · {(d.bytes/1048576).toFixed(1)} MiB {d.path.endsWith("/") && /(?:build|dist|generated|\.gradle|\.idea|target|coverage|cache|vendor|lib)/i.test(d.path) && <button onClick={()=>setExcludes(old=>[...(old ?? DEFAULT_EXCLUDES.join("\n")).split("\n"),d.path].filter((v,i,a)=>a.indexOf(v)===i).join("\n"))}>添加排除建议</button>}</div>)}
        </div>}
        <details>
          <summary>排除规则</summary>
          <textarea
            aria-label="排除规则"
            value={excludes ?? DEFAULT_EXCLUDES.join("\n")}
            placeholder="每行一条"
            onChange={(e) => setExcludes(e.target.value)}
          />
          <p className={cx("help")}>修改后重新打开项目生效。</p>
        </details>
        <h3>审查与修改范围</h3>
        {workspace ? (
          <>
            <small className={cx("path-label")} title={workspace.root}>
              {workspace.root}
            </small>
            <ProjectFileTree
              key={workspace.id}
              files={workspace.files}
              selection={selection}
              setSelection={setSelection}
            />
            <p className={cx("help")}>已选 {selection.length} 项</p>
          </>
        ) : (
          <EmptyState
            icon="folder"
            title="未打开项目"
            compact
          />
        )}
      </div>
      <div hidden={tab !== "nodes"} role="tabpanel">
        <h3>添加预置节点</h3>
        <div className={cx("node-palette")}>
          {nodeKinds.map((kind) => (
            <button
              key={kind}
              disabled={readOnly}
              onClick={() => {
                const id = `${kind}_${crypto.randomUUID().slice(0, 8)}`;
                const node = createNode(
                  kind,
                  id,
                  80 + (workflow.nodes.length % 4) * 240,
                  650 + Math.floor(workflow.nodes.length / 4) * 160,
                );
                setWorkflow((w) => ({ ...w, nodes: [...w.nodes, node] }));
                select(id);
                onAdded();
              }}
            >
              <span className={cx(`palette-icon kind-${kind}`)}>
                <Icon name={nodeIcons[kind]} />
              </span>
              {labels[kind]}
              <span className={cx("plus")}>+</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
