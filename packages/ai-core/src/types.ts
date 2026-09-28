/**
 * ai-core · 核心类型
 *
 * 设计铁律（docs/architecture.md §2）：
 * - 业务代码只依赖本文件的接口，永不直接依赖具体供应商 SDK
 * - 每次调用必须能产出 Usage（真实或估算），成本计量是一等公民
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface ChatStreamResult {
  /** 增量文本块 */
  chunks: AsyncIterable<string>;
  /** 流耗尽后 resolve；供应商未回传时为估算值 */
  usage(): Promise<Usage>;
}

export interface LLMProvider {
  /** 供应商标识（如 "ark"、"bailian"、"mock"） */
  readonly id: string;
  /** 本次路由使用的模型名（计量与报表的聚合键） */
  readonly model: string;
  chat(req: ChatRequest): ChatStreamResult;
}

export type CostTier = "flagship" | "cheap";

/** 任务类型 → 成本档位：重任务用好模型，轻任务用便宜模型（差价 5–20 倍） */
export type TaskType = "dialogue" | "review" | "vocab";
