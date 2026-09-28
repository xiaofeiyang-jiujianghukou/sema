import { describe, expect, it } from "vitest";
import { SCENARIOS, getScenario, listScenarioSummaries } from "./scenarios.js";

describe("情景内容资产质量门槛", () => {
  it("M1 交付 3 个情景，id 唯一", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(3);
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("全部是中→英语言对，字段完整非空", () => {
    for (const s of SCENARIOS) {
      expect(s.sourceLang).toBe("zh");
      expect(s.targetLang).toBe("en");
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.emoji.length).toBeGreaterThan(0);
      expect(s.setting.length).toBeGreaterThan(0);
      expect(s.goals.length).toBeGreaterThanOrEqual(3);
      expect(s.targetVocab.length).toBeGreaterThanOrEqual(3);
      expect(s.persona.name.length).toBeGreaterThan(0);
    }
  });

  it("opener 是纯英文（预生成资产，30 秒开口）", () => {
    for (const s of SCENARIOS) {
      expect(s.opener).toMatch(/[a-zA-Z]/);
      expect(s.opener).not.toMatch(/[\u4e00-\u9fff]/);
      // 以问句/邀请收尾，保证对话能接得住
      expect(s.opener.trim()).toMatch(/[?!.]$/);
    }
  });

  it("systemPrompt 含人设、纯英文规则与自然示范纠错策略", () => {
    for (const s of SCENARIOS) {
      expect(s.systemPrompt).toContain(s.persona.name);
      expect(s.systemPrompt).toContain("ONLY natural English");
      expect(s.systemPrompt).toContain("recast, not lecture");
    }
  });

  it("难度分布覆盖 A2 与 B1", () => {
    const levels = new Set(SCENARIOS.map((s) => s.difficulty));
    expect(levels.has("A2")).toBe(true);
    expect(levels.has("B1")).toBe(true);
  });

  it("getScenario 可查，未知返回 undefined；目录摘要不泄漏 prompt", () => {
    expect(getScenario("coffee-order")?.title).toBe("伦敦咖啡店点单");
    expect(getScenario("nope")).toBeUndefined();
    const summaries = listScenarioSummaries();
    expect(summaries).toHaveLength(SCENARIOS.length);
    for (const summary of summaries) {
      expect(JSON.stringify(summary)).not.toContain("systemPrompt");
    }
  });
});
