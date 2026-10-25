import { z } from "zod";
import { directoryPicker } from "@/lib/server/directory-picker";
import { handle, HttpError, json, readJson, requireSession } from "@/lib/server/security";

const schema = z.object({ path: z.string().max(4000).optional() }).strict();

export function POST(request: Request) {
  return handle(async () => {
    requireSession(request, true);
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, "起始目录无效");
    return json({ path: await directoryPicker.pick(parsed.data.path ?? "", request.signal) });
  });
}
