import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextHistory, interactionGroups } from "../lib/runtime/context";
import { assistantSchema, createDeepSeekClient, ProviderError, type CompletionClient, type Message, type Usage } from "../lib/runtime/deepseek";
import { createTemplate } from "../lib/workflow/templates";
import { workflowSchema } from "../lib/workflow/schema";
const config={model:"deepseek-flash" as const,thinking:true,reasoningEffort:"high" as const};
const usage:Usage={nodeId:"review",model:"deepseek-flash",time:new Date().toISOString(),durationMs:1,promptTokens:10,completionTokens:5,cacheHitTokens:null,cacheMissTokens:null};
const fixed:Message[]=[{role:"system",content:"rules"},{role:"user",content:"task"}];
function turns(n:number):Message[]{return Array.from({length:n},(_,i):Message[]=>[{role:"assistant",content:null,reasoning_content:"reason "+i,tool_calls:[{id:"call"+i,type:"function",function:{name:"read_file",arguments:"{}"}}]},{role:"tool",tool_call_id:"call"+i,content:JSON.stringify({version:"v1",content:"a".repeat(500)})}]).flat();}
test("compaction preserves four complete call/result groups and reasoning; repeat compaction records usage",async()=>{
  const calls:Message[][]=[],archives:object[]=[],summaries:Usage[]=[],stats:object[]=[];
  const client:CompletionClient=async(messages,tools,cfg)=>{assert.equal(tools.length,0);assert.equal(cfg.thinking,false);assert.equal(cfg.purpose,"summary");calls.push(structuredClone(messages));return {assistant:{role:"assistant",content:"summary of progress"},usage};};
  const h=new ContextHistory(fixed,{client,config,signal:new AbortController().signal,nodeId:"review",checkpoint:async()=>({version:"v1",validations:[],scope:["src/a"]}),archive:async entry=>{archives.push(entry);},usage:u=>summaries.push(u),compacted:s=>stats.push(s)});
  h.messages.push(...turns(8));const recent=structuredClone(h.messages.slice(-8));
  assert.equal(await h.compact(true),true);assert.deepEqual(h.messages.slice(-8),recent);assert.equal(interactionGroups(h.messages.slice(4)).length,4);
  assert.equal(h.messages[0].content,"rules");assert.match(h.messages[2].content!,/非读取或验证证据/);assert.match(h.messages[3].content!,/v1/);
  h.messages.push(...turns(6));await h.compact(true);assert.equal(stats.length,2);assert.ok(archives.length>=6);assert.ok(summaries.every(u=>u.purpose==="summary"));assert.equal(calls.length,2);
});
test("automatic compaction uses usage plus output reserve, never rejects large fresh fixed tasks by bytes",async()=>{
 const client:CompletionClient=async()=>({assistant:{role:"assistant",content:"summary"},usage});
 let count=0;const h=new ContextHistory(fixed,{client,config:{...config,maxOutputTokens:100},window:3000,signal:new AbortController().signal,nodeId:"review",checkpoint:async()=>({}),usage:()=>{},compacted:()=>count++});h.messages.push(...turns(10));h.observe({...usage,promptTokens:2500},h.messages);assert.equal(await h.compact(),true);assert.equal(count,1);
 const fresh=new ContextHistory([{role:"user",content:"x".repeat(100000)}],{client,config,signal:new AbortController().signal,nodeId:"review",checkpoint:async()=>({}),usage:()=>{},compacted:()=>{}});assert.equal(await fresh.compact(),false);await assert.rejects(fresh.compact(true),/无法安全压缩/);
});
test("summary failure and cancellation preserve original agent history",async()=>{
 const controller=new AbortController();const client:CompletionClient=async()=>{throw new Error("summary failed");};
 const h=new ContextHistory(fixed,{client,config,signal:controller.signal,nodeId:"review",checkpoint:async()=>({}),usage:()=>{},compacted:()=>{throw new Error("must not commit");}});h.messages.push(...turns(8));const old=structuredClone(h.messages);await assert.rejects(h.compact(true),/summary failed/);assert.deepEqual(h.messages,old);
});
test("DeepSeek accepts >64KiB, >20 tool calls, nullable fields, >4MiB output, and optional output limits",async()=>{
 const tools=Array.from({length:24},(_,i)=>({id:"c"+i,type:"function" as const,function:{name:"read_file",arguments:"{}"}}));assert.equal(assistantSchema.parse({role:"assistant",content:null,reasoning_content:null,tool_calls:tools}).tool_calls?.length,24);
 let sent:Record<string,unknown>={};const client=createDeepSeekClient({apiKey:"test-secret",transport:async(_,init)=>{sent=JSON.parse(String(init?.body));return Response.json({choices:[{finish_reason:"stop",message:{role:"assistant",content:"a".repeat(4*1024*1024+1),reasoning_content:null,tool_calls:null}}],usage:{prompt_tokens:100000,completion_tokens:2}});}});
 const result=await client([{role:"user",content:"x".repeat(70000)}],[],config,new AbortController().signal,"review");assert.ok(result.assistant.content!.length>4*1024*1024);assert.equal("max_tokens" in sent,false);assert.equal("tools" in sent,false);
 await client(fixed,[],{...config,maxOutputTokens:393216},new AbortController().signal,"review");assert.equal(sent.max_tokens,393216);
 const flow=createTemplate();const node=flow.nodes.find(n=>n.kind==="review")!;assert.ok("maxOutputTokens" in node.config===false);assert.equal(workflowSchema.safeParse(flow).success,true);
});
test("only explicit provider context errors trigger compaction recovery",async()=>{
 for(const [status,message,code] of [[400,"maximum context length exceeded","context"],[400,"max_tokens must be less than the context window","request"],[400,"invalid parameter","request"],[401,"invalid key","request"]] as const){const client=createDeepSeekClient({apiKey:"test-secret",transport:async()=>Response.json({error:{message}},{status})});await assert.rejects(client(fixed,[],config,new AbortController().signal,"review"),e=>e instanceof ProviderError&&e.code===code);}
 for(const [finish,code] of [["length","length"],["content_filter","filter"],["insufficient_system_resource","resource"],["aborted","aborted"]] as const){const client=createDeepSeekClient({apiKey:"test-secret",transport:async()=>Response.json({choices:[{finish_reason:finish,message:{role:"assistant",content:null}}]})});await assert.rejects(client(fixed,[],config,new AbortController().signal,"review"),e=>e instanceof ProviderError&&e.code===code);}
});

test("aborted summary cannot commit a rebuilt conversation", async () => {
  const controller = new AbortController();
  const client: CompletionClient = async () => {
    controller.abort(new Error("cancelled during summary"));
    return { assistant: { role: "assistant", content: "late summary" }, usage };
  };
  const history = new ContextHistory(fixed, { client, config, signal: controller.signal, nodeId: "review", checkpoint: async () => ({}), usage: () => {}, compacted: () => assert.fail("aborted compaction committed") });
  history.messages.push(...turns(8));
  const original = structuredClone(history.messages);
  await assert.rejects(history.compact(true), /cancelled during summary/);
  assert.deepEqual(history.messages, original);
});

test("oversized history uses chunk summaries and a merge without splitting retained tool pairs", async()=>{
 let summaries=0;const client:CompletionClient=async(messages,tools)=>{summaries++;assert.equal(tools.length,0);assert.ok(messages[1].content!.length<=120000);return {assistant:{role:"assistant",content:"bounded summary"},usage};};
 const history=new ContextHistory(fixed,{client,config,signal:new AbortController().signal,nodeId:"review",checkpoint:async()=>({version:"v1",validations:[]}),usage:()=>{},compacted:()=>{}});
 const groups=turns(8);groups[1].content="x".repeat(300000);history.messages.push(...groups);
 const recent=structuredClone(history.messages.slice(-8));await history.compact(true);assert.ok(summaries>=4);assert.deepEqual(history.messages.slice(-8),recent);
});
