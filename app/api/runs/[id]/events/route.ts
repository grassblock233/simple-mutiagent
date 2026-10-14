import { manager } from "@/lib/server/manager";
import { handle, HttpError, requireSession } from "@/lib/server/security";
import { type RunState } from "@/lib/workflow/schema";
export function GET(
  request: Request,
  context: RouteContext<"/api/runs/[id]/events">,
) {
  return handle(async () => {
    const session = requireSession(request);
    const { id } = await context.params;
    const entry = manager.get(id, session.id);
    let cursor = Number(
      request.headers.get("last-event-id") ??
        new URL(request.url).searchParams.get("after") ??
        0,
    );
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor > entry.engine.snapshot().events.length
    )
      throw new HttpError(400, "事件序号无效");
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const push = (state: RunState) => {
          if (closed) return;
          for (const event of state.events.filter((e) => e.seq > cursor)) {
            controller.enqueue(
              encoder.encode(
                `id: ${event.seq}\nevent: run-event\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            );
            cursor = event.seq;
          }
          controller.enqueue(
            encoder.encode(
              `event: snapshot\ndata: ${JSON.stringify(state)}\n\n`,
            ),
          );
          if (
            !["pending", "running", "awaiting_approval", "finalizing"].includes(state.status)
          ) {
            cleanup();
            controller.close();
          }
        };
        const timer = setInterval(() => {
          if (Date.now() >= session.expiresAt) {
            cleanup();
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        }, 15000);
        const abort = () => cleanup();
        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          entry.listeners.delete(push);
          request.signal.removeEventListener("abort", abort);
          if (!entry.listeners.size)
            entry.engine.expireApprovals("审核界面断开，待审请求已过期");
        };
        entry.listeners.add(push);
        request.signal.addEventListener("abort", abort, { once: true });
        push(manager.snapshot(id, session.id));
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });
}
