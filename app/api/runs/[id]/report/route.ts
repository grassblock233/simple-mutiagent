import { manager } from "@/lib/server/manager";
import { handle, requireSession } from "@/lib/server/security";
import { markdownReport } from "@/lib/workflow/report";
export function GET(
  request: Request,
  context: RouteContext<"/api/runs/[id]/report">,
) {
  return handle(async () => {
    const session = requireSession(request);
    const { id } = await context.params;
    const state = manager.snapshot(id, session.id);
    const json = new URL(request.url).searchParams.get("format") === "json";
    return new Response(
      json ? JSON.stringify(state, null, 2) : markdownReport(state),
      {
        headers: {
          "Content-Type": json
            ? "application/json; charset=utf-8"
            : "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="workflow-${id}.${json ? "json" : "md"}"`,
          "Cache-Control": "no-store",
        },
      },
    );
  });
}
