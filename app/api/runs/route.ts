import { manager } from "@/lib/server/manager";
import {
  handle,
  HttpError,
  json,
  readJson,
  requireSession,
} from "@/lib/server/security";
import { validateWorkflow } from "@/lib/workflow/validate";
export function POST(request: Request) {
  return handle(async () => {
    const session = requireSession(request, true);
    const value = await readJson(request);
    const validation = validateWorkflow(
      (value as { workflow?: unknown })?.workflow,
    );
    if (!validation.valid)
      throw new HttpError(
        400,
        validation.errors.map((e) => e.message).join("\n"),
      );
    return json(await manager.create(value, session.id), 201);
  });
}
