import { z } from "zod";
import { manager } from "@/lib/server/manager";
import {
  handle,
  HttpError,
  json,
  readJson,
  requireSession,
} from "@/lib/server/security";
const schema = z
  .object({
    id: z.string().uuid(),
    displayHash: z.string().length(64),
    decision: z.enum(["approved", "rejected"]),
  })
  .strict();
export function POST(
  request: Request,
  context: RouteContext<"/api/runs/[id]/approval">,
) {
  return handle(async () => {
    const session = requireSession(request, true);
    const { id } = await context.params;
    const payload = schema.safeParse(await readJson(request));
    if (!payload.success) throw new HttpError(400, "审核请求格式无效");
    const entry = manager.get(id, session.id);
    await entry.writes;
    if (entry.storageFailed) throw new HttpError(409, "运行记录持久化失败，禁止批准执行");
    try {
      entry.engine.decideApproval(
        payload.data.id,
        payload.data.displayHash,
        payload.data.decision,
      );
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
    return json(manager.snapshot(id, session.id));
  });
}
