/**
 * 说嘛 · 价目表（单一事实源）
 *
 * 前端展示、后端扣费、账单明细三处都必须从这里取价。
 * 修改价格 = 修改此文件一处 + 发版，不允许任何散落的魔法数字。
 *
 * 定价锚点（¥1 = 10 积分），上线前用真实成本报表校准。
 */
import { conversationCents, type CreditCents } from "./money.js";

export type PricingUnit = "second" | "count" | "word" | "pack";

export type ActionType =
  | "ai_conversation"
  | "ai_text_turn"
  | "vocab_lookup"
  | "text_translate"
  | "review_report"
  | "vocab_lecture"
  | "scenario_pack";

export interface PriceDef {
  readonly code: ActionType;
  readonly unit: PricingUnit;
  /** 每单位价格（厘） */
  readonly centsPerUnit: number;
  readonly displayName: string;
  readonly description: string;
}

export const PRICING: Readonly<Record<ActionType, PriceDef>> = {
  ai_conversation: {
    code: "ai_conversation",
    unit: "second",
    centsPerUnit: 5, // 5 厘/秒（只计用户实际说话的秒数）
    displayName: "AI 口语对话",
    description: "语音轮次按你实际说话的秒数计费（5 厘/秒，向上取整秒）；静音、闲置、AI 开场白均不计费",
  },
  ai_text_turn: {
    code: "ai_text_turn",
    unit: "count",
    centsPerUnit: 10, // 10 厘/轮 = 0.1 积分/轮
    displayName: "AI 文字对话",
    description: "文字轮次按轮计费（10 厘/轮）；闲置不计费",
  },
  vocab_lookup: {
    code: "vocab_lookup",
    unit: "count",
    centsPerUnit: 1, // 1 厘/次 = 0.01 积分
    displayName: "生词查询",
    description: "结合对话语境的即点即译（LLM 调用）；已在生词本中的词免费",
  },
  text_translate: {
    code: "text_translate",
    unit: "count",
    centsPerUnit: 2, // 2 厘/次 = 0.02 积分
    displayName: "整句翻译",
    description: "长按 AI 消息整句翻成中文（结合对话语境）",
  },
  review_report: {
    code: "review_report",
    unit: "count",
    centsPerUnit: 100, // 1 积分/次
    displayName: "对话复盘报告",
    description: "纠错 + 更地道的说法 + 生词提取",
  },
  vocab_lecture: {
    code: "vocab_lecture",
    unit: "word",
    centsPerUnit: 10, // 0.1 积分/词
    displayName: "生词 AI 精讲",
    description: "例句、辨析、记忆钩子",
  },
  scenario_pack: {
    code: "scenario_pack",
    unit: "pack",
    centsPerUnit: 500, // 5 积分/包
    displayName: "情景课程包",
    description: "预生成情景内容，一次解锁永久使用",
  },
};

/** 注册赠送：30 积分 ≈ 10 分钟对话，够完整体验 1-2 次闭环 */
export const SIGNUP_GRANT_CENTS: CreditCents = 3000;

export function priceOf(code: ActionType): PriceDef {
  return PRICING[code];
}

/** 按价目表估算一笔消费（厘），数量向上取整 */
export function estimateCents(code: ActionType, quantity: number): CreditCents {
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error(`计费数量不合法: ${quantity}`);
  }
  const def = PRICING[code];
  if (def.unit === "second") {
    return conversationCents(quantity, def.centsPerUnit);
  }
  return Math.ceil(quantity * def.centsPerUnit);
}

/** 快捷：按秒估算对话费用 */
export function estimateConversationCents(seconds: number): CreditCents {
  return estimateCents("ai_conversation", seconds);
}
