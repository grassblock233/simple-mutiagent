"use client";
import {
  useMemo,
  useRef,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  buildFileTree,
  scopeState,
  type FileTreeEntry,
} from "@/lib/studio/file-tree";
import type { ScopeSelection } from "./studio-types";
import { cx } from "./studio-styles";
import { Icon } from "./studio-ui";

function Entry({
  entry,
  selection,
  setSelection,
}: {
  entry: FileTreeEntry;
  selection: ScopeSelection[];
  setSelection: Dispatch<SetStateAction<ScopeSelection[]>>;
}) {
  const [open, setOpen] = useState(true);
  const checkbox = useRef<HTMLInputElement>(null);
  const { checked, inherited, partial } = scopeState(entry, selection);
  useEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = partial;
  }, [partial]);
  return (
    <li>
      <div className={cx(`tree-row ${inherited ? "tree-inherited" : ""}`)}>
        {entry.directory ? (
          <button
            className={cx("tree-toggle")}
            aria-expanded={open}
            aria-label={`${open ? "收起" : "展开"}目录 ${entry.path}`}
            onClick={() => setOpen(!open)}
          >
            <Icon name={open ? "chevron-down" : "chevron-right"} />
          </button>
        ) : (
          <span className={cx("tree-spacer")} />
        )}
        <label title={entry.path}>
          <input
            ref={checkbox}
            type="checkbox"
            checked={checked}
            disabled={inherited}
            aria-label={`选择${entry.directory ? "目录" : "文件"} ${entry.path}`}
            onChange={(event) => {
              const checked = event.target.checked;
              setSelection((old) =>
                checked
                  ? [
                      ...old.filter((scope) => scope.path !== entry.path),
                      { path: entry.path, directory: entry.directory },
                    ]
                  : old.filter((scope) => scope.path !== entry.path),
              );
            }}
          />
          <Icon name={entry.directory ? "folder" : "file"} />
          <span>{entry.name}</span>
        </label>
      </div>
      {entry.directory && (
        <ul hidden={!open}>
          {entry.children.map((child) => (
            <Entry
              key={child.path}
              entry={child}
              selection={selection}
              setSelection={setSelection}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
export function ProjectFileTree({
  files,
  selection,
  setSelection,
}: {
  files: string[];
  selection: ScopeSelection[];
  setSelection: Dispatch<SetStateAction<ScopeSelection[]>>;
}) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  return (
    <ul className={cx("file-tree project-tree")} aria-label="项目文件">
      {tree.map((entry) => (
        <Entry
          key={entry.path}
          entry={entry}
          selection={selection}
          setSelection={setSelection}
        />
      ))}
    </ul>
  );
}
