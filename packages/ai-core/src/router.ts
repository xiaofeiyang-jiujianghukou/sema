/**
 * ai-core · 任务路由器
 *
 * 按任务类型选成本档位：dialogue/review → 旗舰档，vocab → 便宜档。
 * 同档位内供应商可随时替换（换配置不动业务）；后续在此叠加
 * 「实时单价 × 健康度」动态选择与故障降级。
 */
import type { CostTier, LLMProvider, TaskType } from "./types.js";

export interface RouteDecision {
  provider: LLMProvider;
  tier: CostTier;
}

export class TaskRouter {
  constructor(
    private readonly providers: Readonly<Record<CostTier, LLMProvider>>,
  ) {}

  route(task: TaskType): RouteDecision {
    const tier: CostTier = task === "vocab" ? "cheap" : "flagship";
    return { provider: this.providers[tier], tier };
  }

  /** 便捷：路由并直接发起对话 */
  chat(
    task: TaskType,
    req: Parameters<LLMProvider["chat"]>[0],
  ): ReturnType<LLMProvider["chat"]> {
    return this.route(task).provider.chat(req);
  }
}
