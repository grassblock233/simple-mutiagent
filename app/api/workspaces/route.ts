import { z } from "zod";
import { manager } from "@/lib/server/manager";
import { handle, HttpError, json, readJson, requireSession } from "@/lib/server/security";
import { DEFAULT_EXCLUDES } from "@/lib/runtime/files";
const schema = z.object({ path: z.string().min(1).max(4000), excludes: z.array(z.string().min(1).max(200)).max(100).optional() }).strict();
export function POST(request: Request) {
  return handle(async () => {
    const session = requireSession(request, true);
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, "目录或排除规则无效");
    try { return json(await manager.workspaces.open(parsed.data.path, session.id, parsed.data.excludes ?? DEFAULT_EXCLUDES)); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "建立工作区失败"); }
  });
}
