import { manager } from "@/lib/server/manager";
import { handle, json, requireSession } from "@/lib/server/security";
export function POST(request: Request, context: RouteContext<"/api/runs/[id]/undo">) {
  return handle(async () => {
    const session = requireSession(request, true);
    const { id } = await context.params;
    return json(await manager.undo(id, session.id));
  });
}
