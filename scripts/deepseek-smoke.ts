import { createRequire } from "node:module";
import { createDeepSeekClient } from "../lib/runtime/deepseek";
const require = createRequire(import.meta.url);
const nextRequire = createRequire(require.resolve("next/package.json"));
nextRequire("@next/env").loadEnvConfig(process.cwd());
async function main() {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("请在 .env.local 配置 DEEPSEEK_API_KEY");
  const client = createDeepSeekClient({ apiKey: process.env.DEEPSEEK_API_KEY });
  const result = await client([{ role: "user", content: "Reply only: OK" }], [], { model: "deepseek-flash", thinking: false, reasoningEffort: "high", maxOutputTokens: 256 }, new AbortController().signal, "smoke");
  console.log(JSON.stringify({ compatible: Boolean(result.assistant.content), model: result.usage.model, usage: result.usage }, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : "联调失败"); process.exitCode = 1; });
