import type { ScanStats } from "../workspace-rules";
import type { Workspace } from "../../components/studio-types";
export async function openWorkspace(path: string, excludes: string[] | undefined, csrf: string, signal: AbortSignal, progress: (stats: ScanStats) => void): Promise<Workspace> {
  const response = await fetch("/api/workspaces", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "text/event-stream", "x-workflow-csrf": csrf }, body: JSON.stringify({ path, ...(excludes ? { excludes } : {}) }), signal });
  if (!response.ok) throw new Error((await response.json()).error || "项目打开失败");
  const reader=response.body?.getReader(); if(!reader)throw new Error("扫描响应为空");
  const decoder=new TextDecoder(); let buffer=""; let workspace: Workspace | undefined;
  try {
    while(true) {
      const chunk=await reader.read(); if(chunk.done)break;
      buffer+=decoder.decode(chunk.value,{stream:true}); let boundary;
      while((boundary=buffer.indexOf("\n\n"))>=0) {
        const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
        const event=frame.split("\n").find(l=>l.startsWith("event: "))?.slice(7);
        const data=frame.split("\n").filter(l=>l.startsWith("data: ")).map(l=>l.slice(6)).join("\n");
        if(!data)continue; const payload=JSON.parse(data);
        if(event==="progress")progress(payload);
        if(event==="complete")workspace=payload;
        if(event==="error")throw new Error(payload.error);
      }
    }
  } finally { await reader.cancel().catch(()=>{}); }
  signal.throwIfAborted(); if(!workspace)throw new Error("扫描连接中断，请重试"); return workspace;
}
