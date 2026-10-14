import {
  handle,
  HttpError,
  json,
  readJson,
  requireSession,
} from "@/lib/server/security";
import { Storage } from "@/lib/server/storage";
import { validateWorkflow } from "@/lib/workflow/validate";
const storage = new Storage();
export function GET(request: Request) {
  return handle(async () => {
    requireSession(request);
    return json({ workflow: await storage.loadWorkflow() });
  });
}
export function PUT(request: Request) {
  return handle(async () => {
    requireSession(request, true);
    const result = validateWorkflow(await readJson(request));
    if (!result.valid)
      throw new HttpError(400, result.errors.map((e) => e.message).join("\n"));
    await storage.saveWorkflow(result.workflow!);
    return json({ saved: true });
  });
}
