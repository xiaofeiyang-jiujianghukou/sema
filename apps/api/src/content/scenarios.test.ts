import { describe, expect, it } from "vitest";
import { SCENARIOS, getScenario, listScenarioSummaries } from "./scenarios.js";

const SCRIPT_CHECK: Record<string, RegExp> = {
  en: /[a-zA-Z]/,
  ja: /[\u3040-\u30ff]/, // 平假名/片假名
  ko: /[\uac00-\ud7af]/, // 谚文
};

describe("情景内容资产质量门槛", () => {
  it("M3 交付 10 个中→英情景 + 日/韩各 6 个情景，id 唯一", () => {
    expect(SCENARIOS.filter((s) => s.targetLang === "en").length).toBeGreaterThanOrEqual(10);
    expect(SCENARIOS.filter((s) => s.targetLang === "ja").length).toBeGreaterThanOrEqual(6);
    expect(SCENARIOS.filter((s) => s.targetLang === "ko").length).toBeGreaterThanOrEqual(6);
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("全部是中→目标语言，字段完整非空", () => {
    for (const s of SCENARIOS) {
      expect(s.sourceLang).toBe("zh");
      expect(["en", "ja", "ko"]).toContain(s.targetLang);
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.emoji.length).toBeGreaterThan(0);
      expect(s.setting.length).toBeGreaterThan(0);
      expect(s.goals.length).toBeGreaterThanOrEqual(3);
      expect(s.targetVocab.length).toBeGreaterThanOrEqual(3);
      expect(s.persona.name.length).toBeGreaterThan(0);
    }
  });

  it("opener 是地道目标语言、以问句/邀请收尾（预生成资产，30 秒开口）", () => {
    for (const s of SCENARIOS) {
      expect(s.opener).toMatch(SCRIPT_CHECK[s.targetLang]!);
      if (s.targetLang !== "ja") {
        expect(s.opener).not.toMatch(/[\u4e00-\u9fff]/); // 不夹中文（日语汉字除外）
      }
      expect(s.opener.trim()).toMatch(/[?!.？!。]$/);
    }
  });

  it("systemPrompt 含人设、纯目标语言规则与自然示范纠错策略", () => {
    for (const s of SCENARIOS) {
      expect(s.systemPrompt).toContain(s.persona.name);
      expect(s.systemPrompt).toMatch(/ONLY natural (English|Japanese|Korean)/);
      expect(s.systemPrompt).toContain("recast, not lecture");
    }
  });

  it("难度分布覆盖 A2 与 B1；日韩语域约定到位（です/ます、해요체）", () => {
    const levels = new Set(SCENARIOS.map((s) => s.difficulty));
    expect(levels.has("A2")).toBe(true);
    expect(levels.has("B1")).toBe(true);
    const ja = SCENARIOS.find((s) => s.targetLang === "ja");
    expect(ja?.systemPrompt).toContain("です/ます");
    const ko = SCENARIOS.find((s) => s.targetLang === "ko");
    expect(ko?.systemPrompt).toContain("해요체");
  });

  it("getScenario 可查，未知返回 undefined；目录摘要不泄漏 prompt 且支持语言过滤", () => {
    expect(getScenario("coffee-order")?.title).toBe("伦敦咖啡店点单");
    expect(getScenario("cafe-order-ja")?.targetLang).toBe("ja");
    expect(getScenario("nope")).toBeUndefined();
    const summaries = listScenarioSummaries();
    // 课程对话课专属场景（lessonOnly）不进自由聊天列表
    expect(summaries).toHaveLength(SCENARIOS.filter((s) => !s.lessonOnly).length);
    for (const summary of summaries) {
      expect(JSON.stringify(summary)).not.toContain("systemPrompt");
    }
    expect(listScenarioSummaries("ja").map((s) => s.id)).toEqual([
      "cafe-order-ja",
      "konbini-lunch-ja",
      "tokyo-directions-ja",
      "ramen-counter-ja",
      "ryokan-checkin-ja",
      "senpai-invite-ja",
    ]);
    expect(listScenarioSummaries("ko").map((s) => s.id)).toEqual([
      "cafe-order-ko",
      "kimbap-shop-ko",
      "subway-help-ko",
      "korean-bbq-ko",
      "hotel-checkin-ko",
      "hongdae-shopping-ko",
    ]);
  });
});
