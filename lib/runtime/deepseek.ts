import { z } from "zod";
import type { RunState } from "../workflow/schema";
import { redact } from "./commands";

const toolCallSchema = z.object({ id: z.string().min(1).max(200), type: z.literal("function"), function: z.object({ name: z.string(), arguments: z.string().max(2 * 1024 * 1024) }) });
export const assistantSchema = z.object({ role: z.literal("assistant"), content: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional(), tool_calls: z.array(toolCallSchema).nullish() });
export type Assistant = z.infer<typeof assistantSchema>;
export type Message = { role: "system" | "user" | "tool"; content: string; tool_call_id?: string } | Assistant;
export type Tool = { type: "function"; function: { name: string; description: string; parameters: object } };
export type ModelConfig = { model: "deepseek-flash"; thinking: boolean; reasoningEffort: "low" | "high" | "max"; maxOutputTokens?: number; purpose?: "agent" | "summary" };
export type Usage = NonNullable<RunState["usage"]>[number];
export type Completion = { assistant: Assistant; usage: Usage };
export type CompletionClient = (messages: Message[], tools: Tool[], config: ModelConfig, signal: AbortSignal, nodeId: string) => Promise<Completion>;
export class ProviderError extends Error {
  constructor(readonly code: "context" | "length" | "filter" | "resource" | "aborted" | "request", message: string) { super(message); }
}
export const MODEL_WINDOW = 1048576;
export function outputReserve(config: ModelConfig) {
  return config.maxOutputTokens ?? (config.thinking ? config.reasoningEffort === "max" ? 131072 : 65536 : 8192);
}
export function createDeepSeekClient(options: { apiKey: string; transport?: typeof fetch; timeoutMs?: number; onUncertain?: (usage: Usage) => void }): CompletionClient {
  return async (messages, tools, config, signal, nodeId) => {
    if (!options.apiKey) throw new Error("未配置 DEEPSEEK_API_KEY");
    const safeMessages: Message[] = JSON.parse(JSON.stringify(messages).split(options.apiKey).join("[REDACTED]"));
    const body = JSON.stringify({ model: config.model, messages: safeMessages, ...(tools.length ? { tools } : {}), stream: false, thinking: { type: config.thinking ? "enabled" : "disabled" }, ...(config.thinking ? { reasoning_effort: config.reasoningEffort } : {}), ...(config.maxOutputTokens === undefined ? {} : { max_tokens: config.maxOutputTokens }) });
    const transport = options.transport ?? fetch;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      const started = Date.now(), time = new Date().toISOString();
      const uncertain: Usage = { nodeId, model: config.model, purpose: config.purpose ?? "agent", time, durationMs: 0, promptTokens: null, completionTokens: null, cacheHitTokens: null, cacheMissTokens: null, uncertain: true };
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)]);
      let response: Response;
      try {
        response = await transport("https://api.deepseek.com/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + options.apiKey, "Content-Type": "application/json" }, body, signal: requestSignal });
      } catch {
        options.onUncertain?.({ ...uncertain, durationMs: Date.now() - started }); signal.throwIfAborted();
        throw new Error("模型请求连接失败或超时；供应商处理和费用结果未知，请检查网络后重试");
      }
      if (!response.ok) {
        options.onUncertain?.({ ...uncertain, durationMs: Date.now() - started });
        // Read only a small bounded error payload, never expose raw provider text.
        let errorText = "";
        const reader = response.body?.getReader();
        if (reader) { try { let bytes = 0; while (bytes < 16384) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; errorText += new TextDecoder().decode(part.value.subarray(0,16384)); } } finally { await reader.cancel(); } }
        if (response.status === 400 && /context_length_exceeded|(?:context (?:window|length)|maximum context length)[^\n]{0,120}(?:exceed|too (?:long|large)|limit exceeded)|(?:exceed|too (?:long|large))[^\n]{0,120}context (?:window|length)|上下文[^\n]{0,50}(?:超出|超过|超限)/i.test(errorText)) throw new ProviderError("context", "DeepSeek 上下文窗口不足，正在尝试压缩历史");
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(new Error("模型重试已取消")); };
            const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 500 * 2 ** attempt);
            signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
          }); continue;
        }
        throw new ProviderError("request", "DeepSeek 请求失败（HTTP " + response.status + "）；请检查密钥、额度与参数");
      }
      let attemptUsage = uncertain;
      try {
        const reader = response.body?.getReader(); if (!reader) throw new Error("DeepSeek 响应为空");
        const chunks: Uint8Array[] = [];
        try {
          while (true) { requestSignal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break; chunks.push(chunk.value); }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        let payload;
        try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("DeepSeek 返回非法 JSON"); }
        const numeric = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
        attemptUsage = { nodeId, model: config.model, purpose: config.purpose ?? "agent", time, durationMs: Date.now() - started, promptTokens: numeric(payload.usage?.prompt_tokens), completionTokens: numeric(payload.usage?.completion_tokens), cacheHitTokens: numeric(payload.usage?.prompt_cache_hit_tokens), cacheMissTokens: numeric(payload.usage?.prompt_cache_miss_tokens) };
        signal.throwIfAborted();
        const choice = payload.choices?.[0];
        const reasons: Record<string, [ProviderError["code"], string]> = {
          length: ["length", "模型输出截断，达到长度上限，未执行不完整工具调用；请提高输出长度或缩小任务后重跑"],
          content_filter: ["filter", "模型输出被供应商过滤；请调整提示词后重跑"],
          insufficient_system_resource: ["resource", "供应商推理资源不足，生成中断；请稍后重试"],
          aborted: ["aborted", "供应商中断了生成；请稍后重试"],
        };
        if (!choice || !["stop", "tool_calls"].includes(choice.finish_reason)) { const reason = reasons[choice?.finish_reason] ?? ["request", "模型返回未知结束原因，请重试"] as const; throw new ProviderError(...reason); }
        const assistant = assistantSchema.parse(choice.message);
        if (assistant.content) assistant.content = redact(assistant.content, [options.apiKey]);
        return { assistant, usage: attemptUsage };
      } catch (error) {
        options.onUncertain?.({ ...attemptUsage, durationMs: Date.now() - started }); throw error;
      }
    }
    throw new Error("模型请求重试预算耗尽");
  };
}
