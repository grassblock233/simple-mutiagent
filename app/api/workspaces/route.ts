import { z } from "zod";
import { manager } from "@/lib/server/manager";
import { handle, HttpError, json, readJson, requireSession } from "@/lib/server/security";
import { DEFAULT_EXCLUDES } from "@/lib/workspace-rules";
const schema = z.object({ path: z.string().min(1).max(4000), excludes: z.array(z.string().min(1).max(200)).max(100).optional() }).strict();
export function POST(request: Request) {
  return handle(async () => {
    const session = requireSession(request, true);
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, "目录或排除规则无效");
    const { path, excludes = DEFAULT_EXCLUDES } = parsed.data;
    if (request.headers.get("accept")?.includes("text/event-stream")) {
      const abort = new AbortController();
      const signal = AbortSignal.any([request.signal, abort.signal]);
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const send = (event: string, value: unknown) => {
            if (!signal.aborted) controller.enqueue(encoder.encode("event: " + event + "\ndata: " + JSON.stringify(value) + "\n\n"));
          };
          void manager.workspaces.open(path, session.id, excludes, { signal, onProgress: stats => send("progress", stats) })
            .then(workspace => send("complete", workspace))
            .catch(error => send("error", { error: error instanceof Error ? error.message : "建立工作区失败" }))
            .finally(() => { if (!abort.signal.aborted) { try { controller.close(); } catch { /* disconnected */ } } });
        },
        cancel() { abort.abort(); },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
    }
    try { return json(await manager.workspaces.open(path, session.id, excludes, { signal: request.signal })); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "建立工作区失败"); }
  });
}
