import { z } from "zod";
import { manager } from "@/lib/server/manager";
import { handle, HttpError, json, readJson, requireSession } from "@/lib/server/security";
export function POST(request: Request, context: RouteContext<"/api/runs/[id]/apply">) {
  return handle(async () => {
    const session = requireSession(request, true);
    const { id } = await context.params;
    const parsed = z.object({ version: z.string().min(1).max(200) }).strict().safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, "需要固定差异版本");
    return json(await manager.apply(id, session.id, parsed.data.version));
  });
}
