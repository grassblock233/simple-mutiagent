import {
  handle,
  json,
  openSession,
  SESSION_COOKIE,
} from "@/lib/server/security";
export function GET(request: Request) {
  return handle(() => {
    const { session, fresh } = openSession(request);
    const response = json({
      csrfToken: session.token,
      expiresAt: session.expiresAt,
      capabilities: {
        phase: 2,
        mode: "real",
        modelConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
        realRuns: process.platform === "linux",
        workspace: process.platform === "linux",
        commands: process.platform === "linux",
        apply: process.platform === "linux",
      },
    });
    if (fresh)
      response.headers.set(
        "Set-Cookie",
        `${SESSION_COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`,
      );
    return response;
  });
}
