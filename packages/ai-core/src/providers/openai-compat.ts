/**
 * ai-core · OpenAI 兼容流式 Provider
 *
 * 一个适配器通吃三家：火山方舟 Ark（/api/v3，OpenAI 兼容）、
 * 阿里百炼 compatible-mode、OpenAI 官方——只需换 baseUrl/model/key。
 * 换供应商 = 换配置，业务代码零改动（docs/architecture.md §2）。
 *
 * 用量：优先采信供应商回传的 usage（stream_options.include_usage），
 * 未回传时按 ~4 字符/token 粗估，事件上标记 measured=false。
 */
import type {
  ChatRequest,
  ChatStreamResult,
  LLMProvider,
  Usage,
} from "../types.js";

export interface OpenAICompatConfig {
  /** 如 https://ark.cn-beijing.volces.com/api/v3 */
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface OpenAIChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export class OpenAICompatProvider implements LLMProvider {
  readonly id = "openai-compat";

  constructor(
    readonly config: OpenAICompatConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get model(): string {
    return this.config.model;
  }

  chat(req: ChatRequest): ChatStreamResult {
    const { fetchImpl, config } = this;
    const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let usageResolve!: (u: Usage) => void;
    const usagePromise = new Promise<Usage>((resolve) => {
      usageResolve = resolve;
    });

    async function* chunks(): AsyncGenerator<string> {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: req.messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        }),
        signal: req.signal ?? null,
      });
      if (!res.ok || !res.body) {
        const detail = res.ok ? "(empty body)" : await safeText(res);
        throw new Error(`LLM upstream HTTP ${res.status}: ${detail}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completionChars = 0;
      let usage: Usage | null = null;

      const handleEvent = (rawEvent: string): string | null => {
        let delta: string | null = null;
        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data.length === 0 || data === "[DONE]") continue;
          try {
            const json = JSON.parse(data) as OpenAIChunk;
            const d = json.choices?.[0]?.delta?.content;
            if (typeof d === "string" && d.length > 0) {
              completionChars += d.length;
              delta = (delta ?? "") + d;
            }
            if (json.usage) {
              usage = {
                promptTokens: json.usage.prompt_tokens ?? 0,
                completionTokens: json.usage.completion_tokens ?? 0,
              };
            }
          } catch {
            // 心跳/残包：忽略
          }
        }
        return delta;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const delta = handleEvent(rawEvent);
          if (delta !== null) yield delta;
        }
      }

      usageResolve(
        usage ?? {
          promptTokens: Math.ceil(
            req.messages.reduce((acc, m) => acc + m.content.length, 0) / 4,
          ),
          completionTokens: Math.ceil(completionChars / 4),
        },
      );
    }

    return { chunks: chunks(), usage: () => usagePromise };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "(unreadable)";
  }
}
