import { manager } from "@/lib/server/manager";
import { handle, json, requireSession } from "@/lib/server/security";
export function GET(request: Request) {
  return handle(async () => {
    const session = requireSession(request);
    return json({ runs: await manager.history(session.id), retention: "手动保留；删除历史同时移除差异、备份与撤销能力。未解决的恢复事务禁止删除。" });
  });
}
