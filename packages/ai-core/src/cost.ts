/**
 * ai-core · 模型成本表（单位经济学）
 *
 * 用途：把 Usage 折算成人民币「成本」，驱动路由决策与毛利报表。
 * 铁律：这里是【分析口径】，用浮点元（¥）；用户计费永远走 @sema/shared
 * 的积分厘（整数），两条线绝不混用。
 *
 * 单价为设计锚点（¥/1M tokens，输入/输出），上线前用 arkcli-pricing 校准。
 */
import type { Usage } from "./types.js";

export interface ModelCost {
  /** ¥ / 1M 输入 tokens */
  inputCnyPerM: number;
  /** ¥ / 1M 输出 tokens */
  outputCnyPerM: number;
}

export const MODEL_COSTS: Readonly<Record<string, ModelCost>> = {
  mock: { inputCnyPerM: 0, outputCnyPerM: 0 },
  // 火山方舟豆包（对话主脑候选，flagship 档）
  "doubao-seed-flash": { inputCnyPerM: 0.15, outputCnyPerM: 1.5 },
  // 阿里百炼 qwen（轻任务候选，cheap 档）
  "qwen-flash": { inputCnyPerM: 0.15, outputCnyPerM: 1.5 },
  // 海外对照锚点
  "gpt-4o-mini": { inputCnyPerM: 1.1, outputCnyPerM: 4.4 },
};

/** 未知模型的兜底成本（宁可高估毛利风险，不可漏算） */
export const DEFAULT_MODEL_COST: ModelCost = { inputCnyPerM: 1, outputCnyPerM: 4 };

export function modelCostOf(model: string): ModelCost {
  const exact = MODEL_COSTS[model];
  if (exact) return exact;
  // 所有 mock 供应商（mock / mock-flagship / mock-cheap …）零成本
  if (model.startsWith("mock")) return MODEL_COSTS.mock as ModelCost;
  return DEFAULT_MODEL_COST;
}

/** Usage → 成本（元，浮点，仅分析口径） */
export function estimateCny(model: string, usage: Usage): number {
  const cost = modelCostOf(model);
  return (
    (usage.promptTokens / 1_000_000) * cost.inputCnyPerM +
    (usage.completionTokens / 1_000_000) * cost.outputCnyPerM
  );
}
