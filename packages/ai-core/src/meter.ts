/**
 * ai-core · 成本计量器
 *
 * 每一次 LLM 调用都必须 record。CostEvent 按「任务 × 模型」聚合成
 * 单位经济学报表（docs/architecture.md §2：成本埋点是一等公民）。
 */
import { estimateCny, modelCostOf } from "./cost.js";
import type { Usage } from "./types.js";

export interface CostEvent {
  model: string;
  usage: Usage;
  /** 本次调用成本（元，分析口径） */
  cny: number;
  /** 供应商真实回传=true；估算=false */
  measured: boolean;
  /** 业务标签（如 sessionId、taskType），用于归集 */
  tags?: Readonly<Record<string, string>> | undefined;
  at: string;
}

export interface CostSummary {
  totalCny: number;
  byModel: Record<string, { cny: number; calls: number; tokens: number }>;
}

export class CostMeter {
  private readonly events: CostEvent[] = [];

  /** 从序列化事件数组重建（PG 持久化用） */
  static from(events: CostEvent[]): CostMeter {
    const meter = new CostMeter();
    meter.events.push(...events);
    return meter;
  }

  record(model: string, usage: Usage, opts: { measured?: boolean | undefined; tags?: Readonly<Record<string, string>> | undefined } = {}): CostEvent {
    const event: CostEvent = {
      model,
      usage,
      cny: estimateCny(model, usage),
      measured: opts.measured ?? false,
      tags: opts.tags,
      at: new Date().toISOString(),
    };
    this.events.push(event);
    return event;
  }

  get all(): readonly CostEvent[] {
    return this.events;
  }

  summary(): CostSummary {
    const byModel: CostSummary["byModel"] = {};
    let totalCny = 0;
    for (const e of this.events) {
      totalCny += e.cny;
      const slot = (byModel[e.model] ??= { cny: 0, calls: 0, tokens: 0 });
      slot.cny += e.cny;
      slot.calls += 1;
      slot.tokens += e.usage.promptTokens + e.usage.completionTokens;
    }
    return { totalCny, byModel };
  }

  /** 平均每分钟对话成本（元）——定价校准的核心指标 */
  avgCnyPerMinute(minutes: number): number {
    if (minutes <= 0) return 0;
    return this.summary().totalCny / minutes;
  }
}

export { estimateCny, modelCostOf };
