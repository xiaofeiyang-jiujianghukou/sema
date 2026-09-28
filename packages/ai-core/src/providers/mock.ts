/**
 * ai-core · Mock LLM
 *
 * 用途：本地开发与测试的零成本供应商——无 Key 也能跑通全链路。
 * 回复内容由注入的脚本函数决定（api 层会用它扮演情景教练）。
 */
import type {
  ChatMessage,
  ChatRequest,
  ChatStreamResult,
  LLMProvider,
  Usage,
} from "../types.js";

/** 4 字符 ≈ 1 token 的粗估（中英混合文本的常用近似） */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export type ReplyScript = (messages: ChatMessage[]) => string;

export class MockLLMProvider implements LLMProvider {
  constructor(
    readonly model: string,
    private readonly reply: ReplyScript = () => "Okay! Tell me more.",
  ) {}

  readonly id = "mock";

  chat(req: ChatRequest): ChatStreamResult {
    const text = this.reply(req.messages);
    const promptTokens = estimateTokens(
      req.messages.reduce((acc, m) => acc + m.content.length, 0),
    );
    const completionTokens = estimateTokens(text.length);

    async function* chunks(): AsyncGenerator<string> {
      // 按词切分，模拟流式输出节奏
      const parts = text.split(/(?<=\s)/);
      for (const part of parts) {
        if (part.length > 0) yield part;
      }
    }

    const usage: Usage = { promptTokens, completionTokens };
    return { chunks: chunks(), usage: () => Promise.resolve(usage) };
  }
}

/** 从历史里取最后一条用户消息的便捷函数（api 层拼 Mock 台词时用） */
export function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === "user") return m.content;
  }
  return "";
}
