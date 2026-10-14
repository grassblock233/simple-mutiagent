import { manager } from "@/lib/server/manager";
import { handle, HttpError, json, readJson, requireSession } from "@/lib/server/security";
import { z } from "zod";
export function POST(request: Request, context: RouteContext<"/api/history/[id]">) {
  return handle(async () => {
    const session = requireSession(request, true);
    const { id } = await context.params;
    return json(await manager.restore(id, session.id));
  });
}
export function DELETE(request: Request, context: RouteContext<"/api/history/[id]">) {
  return handle(async () => {
    const session = requireSession(request, true);
    const { id } = await context.params;
    const parsed = z.object({ acknowledgeLossOfUndo: z.literal(true) }).strict().safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, "删除前需要确认将永久失去本次撤销能力");
    await manager.remove(id, session.id);
    return json({ removed: true });
  });
}
