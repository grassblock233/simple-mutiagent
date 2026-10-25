"use client";
import { useMemo, useRef, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { buildFileTree, scopeState, visibleEntries, coveredFiles, type VisibleEntry } from "@/lib/studio/file-tree";
import type { ScopeSelection } from "./studio-types";
import { cx } from "./studio-styles";
import { Icon } from "./studio-ui";
function Row({ entry, selection, setSelection, open, toggle }: { entry: VisibleEntry; selection: ScopeSelection[]; setSelection: Dispatch<SetStateAction<ScopeSelection[]>>; open: boolean; toggle: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const { checked, inherited, partial } = scopeState(entry, selection);
  useEffect(() => { if (ref.current) ref.current.indeterminate = partial; }, [partial]);
  return <div role="treeitem" aria-selected={checked} aria-level={entry.depth + 1} aria-expanded={entry.directory ? open : undefined} className={cx("tree-row")} style={{ paddingLeft: 4 + entry.depth * 14, height: 30 }}>
    {entry.directory ? <button className={cx("tree-toggle")} aria-label={(open ? "收起目录 " : "展开目录 ") + entry.path} onClick={toggle}><Icon name={open ? "chevron-down" : "chevron-right"} /></button> : <span className={cx("tree-spacer")} />}
    <label title={entry.path}><input ref={ref} type="checkbox" checked={checked} disabled={inherited} aria-label={"选择" + (entry.directory ? "目录 " : "文件 ") + entry.path} onChange={e => { const value=e.target.checked; setSelection(old => value ? [...old.filter(s=>s.path!==entry.path), {path:entry.path,directory:entry.directory}] : old.filter(s=>s.path!==entry.path)); }} /><Icon name={entry.directory ? "folder" : "file"}/><span>{entry.name}</span></label>
    <button className={cx("icon-button")} aria-label={"复制路径 " + entry.path} onClick={() => void navigator.clipboard.writeText(entry.path).catch(()=>{})}><Icon name="copy"/></button>
  </div>;
}
export function ProjectFileTree({ files, selection, setSelection }: { files: string[]; selection: ScopeSelection[]; setSelection: Dispatch<SetStateAction<ScopeSelection[]>> }) {
  const tree=useMemo(()=>buildFileTree(files),[files]);
  const [expanded,setExpanded]=useState<Set<string>>(()=>new Set());
  const [query,setQuery]=useState(""); const [scroll,setScroll]=useState(0); const viewport=useRef<HTMLDivElement>(null);
  const rows=useMemo(()=>visibleEntries(tree,expanded,query),[tree,expanded,query]);
  const covered=useMemo(()=>coveredFiles(files,selection).length,[files,selection]);
  const start=Math.max(0,Math.min(Math.floor(scroll/30)-4,Math.max(0,rows.length-1))), end=Math.min(rows.length,start+20);
  return <>
    <label>搜索文件路径<input aria-label="搜索文件路径" placeholder="文件名或目录路径" value={query} onChange={e=>{setQuery(e.target.value);setScroll(0);if(viewport.current)viewport.current.scrollTop=0;}} /></label>
    <div className={cx("toolbar-buttons")}><button onClick={()=>setExpanded(new Set())}>全部折叠</button><span>{rows.length} 项匹配</span></div>
    <div ref={viewport} className={cx("file-tree virtual-tree")} role="tree" aria-label="项目文件" onScroll={e=>setScroll(e.currentTarget.scrollTop)} style={{height:330,overflow:"auto"}}>
      <div style={{height:rows.length*30,position:"relative"}}><div style={{position:"absolute",top:start*30,left:0,right:0}}>{rows.slice(start,end).map(entry=><Row key={entry.path} entry={entry} selection={selection} setSelection={setSelection} open={Boolean(query)||expanded.has(entry.path)} toggle={()=>setExpanded(old=>{const next=new Set(old);if(next.has(entry.path))next.delete(entry.path);else next.add(entry.path);return next;})}/>)}</div></div>
    </div>
    <details open><summary>已选范围 · {selection.length} 项，覆盖 {covered} 个文件</summary>
      {selection.length>0 && <button onClick={()=>setSelection([])}>清空范围</button>}
      <ul className={cx("selected-scopes")}>{selection.map(s=><li key={s.path}><span title={s.path}>{s.path}{s.directory?"/":""}</span><button aria-label={"移除范围 " + s.path} onClick={()=>setSelection(old=>old.filter(p=>p.path!==s.path))}>移除</button></li>)}</ul>
    </details>
  </>;
}
