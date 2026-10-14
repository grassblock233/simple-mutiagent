import { manager } from "@/lib/server/manager";
import { handle, json, requireSession } from "@/lib/server/security";
export function GET(request: Request, context: RouteContext<"/api/runs/[id]">) {
  return handle(async () => {
    const session = requireSession(request);
    const { id } = await context.params;
    return json(manager.snapshot(id, session.id));
  });
}
