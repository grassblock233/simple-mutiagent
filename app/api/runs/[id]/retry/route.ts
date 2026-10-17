import { manager } from "@/lib/server/manager";
import { handle, HttpError, json, readJson, requireSession } from "@/lib/server/security";
import { z } from "zod";
export function POST(request: Request, context: RouteContext<"/api/runs/[id]/retry">) {
  return handle(async () => {
    const session = requireSession(request, true);
    const { id } = await context.params;
    const state = manager.snapshot(id, session.id);
    if (["pending", "running", "awaiting_approval", "finalizing"].includes(state.status)) throw new HttpError(409, "请先取消或结束当前运行");
    const parsed = z.object({ requestId: z.string().uuid() }).strict().safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, "需要新的幂等标识");
    // Retry creates a new run and baseline; it never replays old approvals or applications.
    return json(await manager.create({ mode: "real", workflow: state.workflow, workspaceId: state.workspace!.id, selection: state.workspace!.selection, repairMode: state.repairMode, requestId: parsed.data.requestId }, session.id), 201);
  });
}
