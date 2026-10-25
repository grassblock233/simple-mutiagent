import { z } from "zod";
import { manager } from "@/lib/server/manager";
import { handle, HttpError, json, requireSession } from "@/lib/server/security";
const querySchema = z.object({ path: z.string().min(1).max(500), version: z.string().regex(/^[a-f0-9]{64}$/), startLine: z.coerce.number().int().positive(), endLine: z.coerce.number().int().positive() });
export function GET(request: Request, context: RouteContext<"/api/runs/[id]/source">) {
  return handle(async () => {
    const session = requireSession(request);
    const { id } = await context.params;
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success || parsed.data.path.split("/").some(p => !p || p === "." || p === "..") || parsed.data.path.includes("\\")) throw new HttpError(400, "文件路径、内容版本或行范围无效");
    return json(await manager.source(id, session.id, parsed.data));
  });
}
