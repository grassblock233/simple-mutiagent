"use client";
import type { Dispatch, SetStateAction } from "react";
import { cx } from "./studio-styles";
import { Icon, EmptyState, handleTabKeys, nodeIcons } from "./studio-ui";
import { ProjectFileTree } from "./project-file-tree";
import { createNode } from "@/lib/workflow/templates";
import { labels, nodeKinds, type Workflow } from "@/lib/workflow/schema";
import type {
  StudioActions,
  Workspace,
  DirectoryBrowse,
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
  browse?: DirectoryBrowse;
  setBrowse: Setter<DirectoryBrowse | undefined>;
  workflow: Workflow;
  setWorkflow: Setter<Workflow>;
  select: Setter<string>;
  onAdded: () => void;
  onOpened: () => void;
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
  browse,
  setBrowse,
  workflow,
  setWorkflow,
  select,
  onAdded,
  onOpened,
  csrf,
  busy,
  action,
  api,
  setNotice,
}: Props) {
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
                setBrowse(
                  await api<DirectoryBrowse>(
                    `/api/workspaces?path=${encodeURIComponent(workspacePath)}`,
                  ),
                );
              })
            }
          >
            浏览目录
          </button>
          <button
            disabled={busy || !csrf || !workspacePath}
            onClick={() =>
              action(async () => {
                const next = await api<Workspace>("/api/workspaces", "POST", {
                  path: workspacePath,
                  ...(excludes === undefined
                    ? {}
                    : {
                        excludes: excludes
                          .split("\n")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      }),
                });
                setWorkspace(next);
                onOpened();
                setSelection([]);
                setExcludes(next.excludes.join("\n"));
                setNotice("项目已打开，请选择范围。");
              })
            }
          >
            打开项目
          </button>
        </div>
        {browse && (
          <div className={cx("directory-browser")}>
            <button
              onClick={() =>
                action(async () => {
                  setWorkspacePath(browse.parent);
                  setBrowse(
                    await api<DirectoryBrowse>(
                      `/api/workspaces?path=${encodeURIComponent(browse.parent)}`,
                    ),
                  );
                })
              }
            >
              ↑ 上级目录
            </button>
            <button
              onClick={() => {
                setWorkspacePath(browse.root);
                setBrowse(undefined);
              }}
            >
              选择此目录
            </button>
            {browse.directories.map((d) => (
              <button
                key={d.path}
                onClick={() =>
                  action(async () => {
                    setWorkspacePath(d.path);
                    setBrowse(
                      await api<DirectoryBrowse>(
                        `/api/workspaces?path=${encodeURIComponent(d.path)}`,
                      ),
                    );
                  })
                }
              >
                ▸ {d.name}
              </button>
            ))}
          </div>
        )}
        <details>
          <summary>排除规则</summary>
          <textarea
            aria-label="排除规则"
            value={excludes ?? ""}
            placeholder="打开项目后展示默认规则；每行一条"
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
            title="连接你的项目"
            description="打开项目后选择文件或目录。"
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
