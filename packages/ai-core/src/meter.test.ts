import { describe, expect, it } from "vitest";
import { estimateCny, modelCostOf } from "./cost.js";
import { CostMeter } from "./meter.js";

describe("模型成本表", () => {
  it("mock 供应商零成本", () => {
    const cny = estimateCny("mock", { promptTokens: 1_000_000, completionTokens: 1_000_000 });
    expect(cny).toBe(0);
  });

  it("按输入/输出单价折算（doubao-seed-flash：0.15 / 1.5 元每百万）", () => {
    const cny = estimateCny("doubao-seed-flash", { promptTokens: 1_000_000, completionTokens: 500_000 });
    expect(cny).toBeCloseTo(0.15 + 0.75, 10);
  });

  it("未知模型用兜底成本（宁可高估）", () => {
    expect(modelCostOf("totally-unknown")).toEqual({ inputCnyPerM: 1, outputCnyPerM: 4 });
  });
});

describe("CostMeter", () => {
  it("记录事件并按模型聚合", () => {
    const meter = new CostMeter();
    meter.record("doubao-seed-flash", { promptTokens: 1_000_000, completionTokens: 0 }, { measured: true });
    meter.record("doubao-seed-flash", { promptTokens: 0, completionTokens: 1_000_000 }, { tags: { sessionId: "s1" } });
    meter.record("mock", { promptTokens: 999, completionTokens: 999 });

    const summary = meter.summary();
    expect(summary.totalCny).toBeCloseTo(0.15 + 1.5, 10);
    expect(summary.byModel["doubao-seed-flash"]?.calls).toBe(2);
    expect(summary.byModel["mock"]?.calls).toBe(1);
    expect(meter.all).toHaveLength(3);
    expect(meter.all[0]?.measured).toBe(true);
  });

  it("每分钟成本指标", () => {
    const meter = new CostMeter();
    meter.record("doubao-seed-flash", { promptTokens: 1_000_000, completionTokens: 0 });
    expect(meter.avgCnyPerMinute(10)).toBeCloseTo(0.015, 10);
    expect(meter.avgCnyPerMinute(0)).toBe(0);
  });
});
