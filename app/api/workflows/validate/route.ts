import { handle, json, readJson, requireSession } from "@/lib/server/security";
import { validateWorkflow } from "@/lib/workflow/validate";
export function POST(request: Request) {
  return handle(async () => {
    requireSession(request, true);
    return json(validateWorkflow(await readJson(request)));
  });
}
