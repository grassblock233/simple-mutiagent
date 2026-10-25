import { workflowSchema, type Workflow, type WorkflowNode } from "../workflow/schema";
import { z } from "zod";
export const draftKey = "simple-workflow-draft-v1";
export type JsonBuffer = { text: string; base: string };
export const nodeJson = (node: WorkflowNode) => JSON.stringify({ config: node.config, inputs: node.inputs }, null, 2);
const scope = z.object({ path: z.string(), directory: z.boolean() });
// Structural validation permits temporarily invalid labels and graphs while editing.
const draftWorkflow = z.object({ formatVersion:z.literal(1), name:z.string(), nodes:z.array(z.object({id:z.string(),kind:z.enum(["read","review","repair","rereview","branch","loop","output"]),label:z.string(),position:z.object({x:z.number(),y:z.number()}),config:z.record(z.string(),z.unknown()),inputs:z.record(z.string(),z.object({sources:z.array(z.string()),output:z.enum(["material","review","repair"]),freshness:z.enum(["baseline","current"])}))})),edges:workflowSchema.shape.edges });
const dataSchema = z.object({ id:z.string(), revision:z.number().int().nonnegative(), workflow:draftWorkflow, workspacePath:z.string(), openedRoot:z.string().optional(), excludes:z.string().optional(), selection:z.array(scope), repairMode:z.enum(["confirm","automatic"]), selectedId:z.string(), buffers:z.record(z.string(),z.object({text:z.string(),base:z.string()})), savedFingerprint:z.string(), runBinding:z.object({runId:z.string(),draftId:z.string(),revision:z.number(),executionKey:z.string()}).optional() });
export type DraftData = Omit<z.infer<typeof dataSchema>,"workflow"> & {workflow:Workflow};
export type DraftEnvelope = { version:1; data:DraftData; undo?:DraftData };
export function persistDraft(storage: Pick<Storage, "setItem">, data: DraftData, undo?: DraftData): boolean {
  try { storage.setItem(draftKey, JSON.stringify({ version: 1, data, undo })); return true; }
  catch { return false; }
}
export async function saveBeforeReplace(save: () => Promise<void>, replace: () => void) {
  await save();
  replace();
}
export function readDraft(raw: string | null): DraftEnvelope | undefined {
  if(!raw)return; try { const parsed=z.object({version:z.literal(1),data:dataSchema,undo:dataSchema.optional()}).parse(JSON.parse(raw)); return parsed as DraftEnvelope; }catch{return;}
}
export const workflowFingerprint = (w:Workflow) => JSON.stringify(w);
export function executionKey(w:Workflow, root:string|undefined, excludes:string|undefined, selection:{path:string;directory:boolean}[], mode:string) {
  return JSON.stringify({ workflow:w,root,excludes,selection,mode });
}
export function hasPendingJson(workflow:Workflow,buffers:Record<string,JsonBuffer>) {
  return workflow.nodes.some(n=>buffers[n.id] && buffers[n.id].text!==buffers[n.id].base && buffers[n.id].text!==nodeJson(n));
}
