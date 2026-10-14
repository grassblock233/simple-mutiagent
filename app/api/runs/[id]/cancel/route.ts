import { manager } from "@/lib/server/manager";
import { handle, json, requireSession } from "@/lib/server/security";
export function POST(
  request: Request,
  context: RouteContext<"/api/runs/[id]/cancel">,
) {
  return handle(async () => {
    const session = requireSession(request, true);
    const { id } = await context.params;
    const entry = manager.get(id, session.id);
    entry.engine.cancel();
    return json(manager.snapshot(id, session.id));
  });
}
