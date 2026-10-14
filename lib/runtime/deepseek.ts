import { z } from "zod";
import type { RunState } from "../workflow/schema";
import { redact } from "./commands";

const toolCallSchema = z.object({ id: z.string().min(1).max(200), type: z.literal("function"), function: z.object({ name: z.string(), arguments: z.string().max(2 * 1024 * 1024) }) });
export const assistantSchema = z.object({ role: z.literal("assistant"), content: z.string().nullable().optional(), reasoning_content: z.string().optional(), tool_calls: z.array(toolCallSchema).max(20).optional() });
export type Assistant = z.infer<typeof assistantSchema>;
export type Message = { role: "system" | "user" | "tool"; content: string; tool_call_id?: string } | Assistant;
export type Tool = { type: "function"; function: { name: string; description: string; parameters: object } };
export type ModelConfig = { model: "deepseek-flash"; thinking: boolean; reasoningEffort: "low" | "high" | "max"; maxOutputTokens: number };
export type Usage = NonNullable<RunState["usage"]>[number];
export type Completion = { assistant: Assistant; usage: Usage };
export type CompletionClient = (messages: Message[], tools: Tool[], config: ModelConfig, signal: AbortSignal, nodeId: string) => Promise<Completion>;

export function createDeepSeekClient(options: { apiKey: string; transport?: typeof fetch; timeoutMs?: number; onUncertain?: (usage: Usage) => void }): CompletionClient {
  return async (messages, tools, config, signal, nodeId) => {
    if (!options.apiKey) throw new Error("未配置 DEEPSEEK_API_KEY");
    if (Buffer.byteLength(JSON.stringify(messages)) > 64 * 1024) throw new Error("Agent 上下文达到保守输入预算（64 KiB），停止且不裁剪工具历史");
    // Preserve full assistant reasoning_content even on turns without tool calls.
    const safeMessages: Message[] = JSON.parse(JSON.stringify(messages).split(options.apiKey).join("[REDACTED]"));
    const body = JSON.stringify({ model: config.model, messages: safeMessages, tools, stream: false, thinking: { type: config.thinking ? "enabled" : "disabled" }, ...(config.thinking ? { reasoning_effort: config.reasoningEffort } : {}), max_tokens: config.maxOutputTokens });
    const transport = options.transport ?? fetch;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      const started = Date.now();
      const time = new Date().toISOString();
      const uncertain: Usage = { nodeId, model: config.model, time, durationMs: 0, promptTokens: null, completionTokens: null, cacheHitTokens: null, cacheMissTokens: null, uncertain: true };
      let response: Response;
      try {
        response = await transport("https://api.deepseek.com/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" }, body, signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)]) });
      } catch {
        options.onUncertain?.({ ...uncertain, durationMs: Date.now() - started });
        signal.throwIfAborted();
        // Timeouts may already have been billed. Do not hide uncertain outcomes behind retries.
        throw new Error("模型请求连接失败或超时；供应商处理和费用结果未知");
      }
      if (!response.ok) {
        options.onUncertain?.({ ...uncertain, durationMs: Date.now() - started });
        await response.body?.cancel();
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(new Error("模型重试已取消")); };
            const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 500 * 2 ** attempt);
            signal.addEventListener("abort", abort, { once: true });
          });
          continue;
        }
        throw new Error(`DeepSeek 请求失败（HTTP ${response.status}）；请检查密钥、额度与参数`);
      }
      let attemptUsage = uncertain;
      try {
      // Keep the timeout active while reading the response body as well.
      const reader = response.body?.getReader();
      if (!reader) throw new Error("DeepSeek 响应为空");
      const chunks: Uint8Array[] = []; let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new Error("DeepSeek 响应超过 4 MiB 上限"); }
        chunks.push(chunk.value);
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("DeepSeek 返回非法 JSON"); }
      const numeric = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
      attemptUsage = { nodeId, model: config.model, time, durationMs: Date.now() - started, promptTokens: numeric(payload.usage?.prompt_tokens), completionTokens: numeric(payload.usage?.completion_tokens), cacheHitTokens: numeric(payload.usage?.prompt_cache_hit_tokens), cacheMissTokens: numeric(payload.usage?.prompt_cache_miss_tokens) };
      signal.throwIfAborted();
      const choice = payload.choices?.[0];
      if (!choice || !["stop", "tool_calls"].includes(choice.finish_reason)) throw new Error("模型响应截断、拒绝或结束原因无效");
      const assistant = assistantSchema.parse(choice.message);
      // Do not return the key or raw provider errors to callers.
      if (assistant.content) assistant.content = redact(assistant.content, [options.apiKey]);
      return { assistant, usage: attemptUsage };
      } catch (error) {
        options.onUncertain?.({ ...attemptUsage, durationMs: Date.now() - started });
        throw error;
      }
    }
    throw new Error("模型请求重试预算耗尽");
  };
}
