import { randomBytes, timingSafeEqual } from "node:crypto";
import { connection } from "next/server";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
type Session = { id: string; token: string; expiresAt: number };
const globalSessions = globalThis as typeof globalThis & {
  workflowSessions?: Map<string, Session>;
};
const sessions = (globalSessions.workflowSessions ??= new Map());
export const SESSION_COOKIE = "simple_workflow_session";

export function checkLocalRequest(request: Request) {
  const host = request.headers.get("host");
  if (!host) throw new HttpError(403, "缺少本地 Host");
  let origin: URL;
  try {
    origin = new URL(`http://${host}`);
  } catch {
    throw new HttpError(403, "无效 Host");
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
    throw new HttpError(403, "只接受回环地址请求");
  const expected = new URL(request.url);
  // Next.js may normalize request.url's hostname to localhost even when Host is 127.0.0.1.
  // Bind the listener port, and compare browser origins against the validated Host.
  if (expected.port !== origin.port)
    throw new HttpError(403, "Host 端口不匹配");
  const expectedOrigin = `${expected.protocol}//${origin.host}`;
  const suppliedOrigin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site")
    throw new HttpError(403, "拒绝跨站请求");
  if (suppliedOrigin && suppliedOrigin !== expectedOrigin)
    throw new HttpError(403, "Origin 不匹配");
  if (referer) {
    try {
      if (new URL(referer).origin !== expectedOrigin) throw new Error();
    } catch {
      throw new HttpError(403, "Referer 不匹配");
    }
  }
}
function cookieId(request: Request) {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
}
export function openSession(request: Request): {
  session: Session;
  fresh: boolean;
} {
  checkLocalRequest(request);
  const now = Date.now();
  for (const [id, session] of sessions)
    if (session.expiresAt < now) sessions.delete(id);
  const existing = sessions.get(cookieId(request) ?? "");
  if (existing) return { session: existing, fresh: false };
  if (sessions.size >= 100) throw new HttpError(429, "本地会话数量超过限制");
  const session = {
    id: randomBytes(24).toString("hex"),
    token: randomBytes(32).toString("hex"),
    expiresAt: now + 8 * 60 * 60 * 1000,
  };
  sessions.set(session.id, session);
  return { session, fresh: true };
}
export function requireSession(request: Request, mutation = false): Session {
  checkLocalRequest(request);
  const session = sessions.get(cookieId(request) ?? "");
  if (!session || session.expiresAt < Date.now())
    throw new HttpError(401, "本地会话已失效，请刷新页面");
  if (mutation) {
    const token = request.headers.get("x-workflow-csrf") ?? "";
    const received = Buffer.from(token);
    const expected = Buffer.from(session.token);
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    )
      throw new HttpError(403, "防伪令牌不匹配");
    if (
      request.headers.get("content-type")?.split(";")[0].trim() !==
      "application/json"
    )
      throw new HttpError(415, "需要 application/json");
  }
  return session;
}
export async function readJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > 1024 * 1024)
    throw new HttpError(413, "请求超过 1 MiB");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "缺少请求体");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1024 * 1024) {
      await reader.cancel();
      throw new HttpError(413, "请求超过 1 MiB");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求不是有效 JSON");
  }
}
export function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
export async function handle(
  action: () => Promise<Response> | Response,
): Promise<Response> {
  // Opt into request-time execution before the catch can intercept a prerender bailout.
  await connection();
  try {
    return await action();
  } catch (error) {
    if (error instanceof HttpError)
      return json({ error: error.message }, error.status);
    // Do not expose arbitrary exception strings, paths or environment values.
    console.error(
      "Workflow API failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return json({ error: "操作失败，请检查本地服务日志" }, 500);
  }
}
