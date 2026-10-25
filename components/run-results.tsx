"use client";
import { useRef, useState } from "react";
import type { RunState } from "@/lib/workflow/schema";
import type { StudioActions } from "./studio-types";
import { cx } from "./studio-styles";
import { nodeStatusLabels } from "./studio-ui";
type Source = {path:string;version:string;startLine:number;endLine:number;totalLines:number;content:string};
export function RunResults({run,selectedId,api}:{run:RunState;selectedId:string;api:StudioActions["api"]}) {
  const [severity,setSeverity]=useState("all"),[status,setStatus]=useState("all"),[file,setFile]=useState("all"),[selectedOnly,setSelectedOnly]=useState(false);
  const [source,setSource]=useState<{data?:Source;error?:string;loading?:boolean;highlight:[number,number]}>();
  const sourceRequest = useRef(0);
  const nodeIssues=new Set(run.records.filter(r=>r.nodeId===selectedId).flatMap(r=>r.output?.type==="review"?r.output.issues.map(i=>i.id):[]));
  const issues=run.issues.filter(i=>(severity==="all"||i.severity===severity)&&(status==="all"||i.status===status)&&(file==="all"||i.path===file)&&(!selectedOnly||nodeIssues.has(i.id)));
  const labels={open:"未解决",resolved:"已解决",unconfirmed:"待确认",blocking:"阻塞",suggestion:"建议",passed:"通过",failed:"失败",missing:"未完成"};
  async function locate(issue:RunState["issues"][number]) {
    const request = ++sourceRequest.current;
    const highlight:[number,number]=[issue.startLine,issue.endLine];setSource({loading:true,highlight});
    try { const query=new URLSearchParams({path:issue.path,version:issue.version,startLine:String(Math.max(1,issue.startLine-5)),endLine:String(Math.min(issue.endLine+5,issue.startLine+204))});const data=await api<Source>("/api/runs/"+run.id+"/source?"+query);if(request===sourceRequest.current)setSource({data,highlight}); }
    catch(error){if(request===sourceRequest.current)setSource({error:error instanceof Error?error.message:"源码不可用",highlight});}
  }
  return <div className={cx("node-records")}>
    <div className={cx("result-filters")}>
      <select aria-label="筛选严重程度" value={severity} onChange={e=>setSeverity(e.target.value)}><option value="all">全部严重程度</option><option value="blocking">阻塞</option><option value="suggestion">建议</option></select>
      <select aria-label="筛选问题状态" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">全部状态</option>{["open","resolved","unconfirmed"].map(s=><option value={s} key={s}>{labels[s as keyof typeof labels]}</option>)}</select>
      <select aria-label="筛选文件" value={file} onChange={e=>setFile(e.target.value)}><option value="all">全部文件</option>{[...new Set(run.issues.map(i=>i.path))].map(path=><option key={path}>{path}</option>)}</select>
      <label className={cx("checkbox-label")}><input type="checkbox" checked={selectedOnly} onChange={e=>setSelectedOnly(e.target.checked)}/>仅选中节点</label>
    </div>
    <h3>审查问题 · {issues.length}/{run.issues.length}</h3>
    {!issues.length && <p>{run.issues.length?"没有匹配的问题。":run.conclusion==="passed"?"审查完成，未发现待处理问题。":"尚未产生问题；请同时查看执行状态及验证结果。"}</p>}
    {issues.map(issue=><article className={cx("issue-card")} data-severity={issue.severity} key={issue.id}><header><strong>{issue.id} · {labels[issue.severity]}</strong><span>{labels[issue.status]}</span><button onClick={()=>void locate(issue)} title={issue.path}>{issue.path}:{issue.startLine}–{issue.endLine}</button></header><p>{issue.description}</p><strong>证据</strong><p>{issue.evidence}</p><strong>建议</strong><p>{issue.suggestion}</p></article>)}
    {source && <section aria-label="对应版本源码"><div className={cx("toolbar-buttons")}><strong>{source.data?.path ?? "源码定位"}</strong><button onClick={()=>setSource(undefined)}>关闭源码</button></div>{source.loading?<p>正在读取对应版本…</p>:source.error?<p role="alert">{source.error}</p>:source.data&&<><small title={source.data.version}>版本 {source.data.version.slice(0,12)} · 只读</small><div className={cx("source-view")}>{source.data.content.split("\n").map((line,i)=>{const number=source.data!.startLine+i;const content=<><code>{number}</code>{line || " "}</>;return <div key={number} className={cx("source-line")}>{number>=source.highlight[0]&&number<=source.highlight[1]?<mark>{content}</mark>:<span>{content}</span>}</div>;})}</div></>}</section>}
    <h3>验证与修复记录</h3>
    {run.records.filter(r=>!selectedOnly||r.nodeId===selectedId).map(record=><section key={record.id} className={cx("issue-card")}><strong>{record.nodeId} · 第 {record.round} 轮 · {nodeStatusLabels[record.status]}</strong>
      {record.error&&<p role="alert">{record.error}</p>}
      {record.output?.type==="review"&&<>{record.output.validations.map((v,i)=><p key={i}>{v.name} · {labels[v.status]}{v.required?"（必要）":""}</p>)}{record.output.limitations.length>0&&<details><summary>说明与限制</summary>{record.output.limitations.map((l,i)=><p key={i}>{l}</p>)}</details>}</>}
      {record.output?.type==="repair"&&<>{record.output.resolutions.map((r,i)=><p key={i}>{r.issueId}：{r.explanation}</p>)}{record.output.unrepairable.map((r,i)=><p key={i}>无法修复：{r}</p>)}</>}
      <details><summary>输入、输出及完整版本详情</summary><pre>{JSON.stringify({inputVersion:record.inputVersion,input:record.input,output:record.output,error:record.error},null,2)}</pre></details>
    </section>)}
  </div>;
}
