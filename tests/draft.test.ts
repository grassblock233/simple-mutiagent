import { test } from "node:test";
import assert from "node:assert/strict";
import { createTemplate } from "../lib/workflow/templates";
import { executionKey, hasPendingJson, nodeJson, persistDraft, saveBeforeReplace, readDraft, workflowFingerprint, type DraftData } from "../lib/studio/draft";
import { buildFileTree, coveredFiles, visibleEntries } from "../lib/studio/file-tree";
function draft():DraftData {const workflow=createTemplate();return {id:"draft-1",revision:5,workflow,workspacePath:"/test",openedRoot:"/test",excludes:".git/",selection:[{path:"src",directory:true}],repairMode:"confirm",selectedId:"review",buffers:{review:{text:"{invalid",base:nodeJson(workflow.nodes[1])}},savedFingerprint:workflowFingerprint(workflow),runBinding:{runId:"run1",draftId:"draft-1",revision:5,executionKey:"key"}};}
test("local draft roundtrips invalid JSON, selections, revision, binding and one undo without sources or credentials",()=>{
 const data=draft(),undo={...draft(),id:"before"};const raw=JSON.stringify({version:1,data,undo});const result=readDraft(raw);assert.deepEqual(result,{version:1,data,undo});assert.equal(result!.data.buffers.review.text,"{invalid");assert.equal(hasPendingJson(data.workflow,data.buffers),true);
 for(const bad of [null,"{",'{}','{"version":2,"data":{}}'])assert.equal(readDraft(bad),undefined);
 data.workflow.name="";data.workflow.nodes[1].label="";assert.ok(readDraft(JSON.stringify({version:1,data})));
});
test("pristine JSON buffer follows form; edited JSON remains pending and execution keys change with inputs",()=>{
 const data=draft(),node=data.workflow.nodes[1],base=nodeJson(node);data.buffers.review={text:base,base};node.label="new";assert.equal(hasPendingJson(data.workflow,data.buffers),false);if(node.kind==="review")node.config.prompt="changed";assert.equal(hasPendingJson(data.workflow,data.buffers),false);data.buffers.review.text="{invalid";assert.equal(hasPendingJson(data.workflow,data.buffers),true);
 assert.notEqual(executionKey(data.workflow,"/a",undefined,[],"confirm"),executionKey(data.workflow,"/b",undefined,[],"confirm"));
});
test("search opens ancestors without altering selection or saved expansion; large trees have finite visible rows",()=>{
 const files=Array.from({length:2000},(_,i)=>"src/deep/"+i+".ts");const tree=buildFileTree(files),expanded=new Set<string>();assert.equal(visibleEntries(tree,expanded,"").length,1);assert.equal(visibleEntries(tree,expanded,"1999.ts").length,3);assert.equal(expanded.size,0);assert.equal(visibleEntries(tree,expanded,"").length,1);assert.equal(coveredFiles(files,[{path:"src",directory:true}]).length,2000);assert.equal(coveredFiles(files,[{path:"src2",directory:true}]).length,0);
});
test("storage failures are explicit and failed server saves cannot replace the draft", async () => {
 const data=draft();let replaced=false;
 assert.equal(persistDraft({setItem(){throw new Error("quota");}},data),false);
 let raw="";assert.equal(persistDraft({setItem(_key,value){raw=value;}},data,data),true);
 assert.deepEqual(readDraft(raw),{version:1,data,undo:data});
 await assert.rejects(saveBeforeReplace(async()=>{throw new Error("server save failed");},()=>{replaced=true;}),/server save failed/);
 assert.equal(replaced,false);
 await saveBeforeReplace(async()=>{},()=>{replaced=true;});assert.equal(replaced,true);
});
