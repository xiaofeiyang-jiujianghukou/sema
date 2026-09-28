/**
 * ai-core · 任务路由器
 *
 * 按任务类型选成本档位：dialogue/review → 旗舰档，vocab → 便宜档。
 * review 可选专属供应商（结构化复盘对指令遵循要求高，与对话模型解耦）；
 * 同档位内供应商可随时替换（换配置不动业务）；后续在此叠加
 * 「实时单价 × 健康度」动态选择与故障降级。
 */
import type { CostTier, LLMProvider, TaskType } from "./types.js";

export interface RouteDecision {
  provider: LLMProvider;
  tier: CostTier;
}

export interface TaskRouterOptions extends Partial<Record<CostTier, LLMProvider>> {
  /** 复盘专用供应商（缺省回落旗舰档） */
  review?: LLMProvider;
}

export class TaskRouter {
  private readonly providers: Readonly<Record<CostTier, LLMProvider>>;
  private readonly reviewProvider: LLMProvider | null;

  constructor(providers: TaskRouterOptions) {
    const { review, ...tiers } = providers;
    const flagship = tiers.flagship ?? tiers.cheap;
    const cheap = tiers.cheap ?? tiers.flagship;
    if (!flagship || !cheap) {
      throw new Error("TaskRouter 需要至少提供一个供应商（flagship 或 cheap）");
    }
    this.providers = { flagship, cheap };
    this.reviewProvider = review ?? null;
  }

  route(task: TaskType): RouteDecision {
    if (task === "review" && this.reviewProvider) {
      return { provider: this.reviewProvider, tier: "flagship" };
    }
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
