import { describe, expect, it } from "vitest";
import {
  CENTS_PER_CREDIT,
  CENTS_PER_CNY,
  conversationCents,
  formatCredits,
  formatYuanRef,
} from "./money.js";
import {
  estimateCents,
  estimateConversationCents,
  priceOf,
  SIGNUP_GRANT_CENTS,
} from "./pricing.js";

describe("money 积分数学", () => {
  it("1 积分 = 100 厘，¥1 = 1000 厘", () => {
    expect(CENTS_PER_CREDIT).toBe(100);
    expect(CENTS_PER_CNY).toBe(1000);
  });

  it("对话按秒计费：5 厘/秒", () => {
    expect(conversationCents(1, 5)).toBe(5);
    expect(conversationCents(60, 5)).toBe(300); // 1 分钟 = 3 积分
    expect(conversationCents(65, 5)).toBe(325); // 1分05秒 = 3.25 积分
    expect(conversationCents(0, 5)).toBe(0);
  });

  it("对话秒数不合法时抛错", () => {
    expect(() => conversationCents(-1, 5)).toThrow();
    expect(() => conversationCents(NaN, 5)).toThrow();
  });

  it("formatCredits 整数与零头显示", () => {
    expect(formatCredits(3000)).toBe("30");
    expect(formatCredits(3050)).toBe("30.5");
    expect(formatCredits(5)).toBe("0.05");
    expect(formatCredits(100)).toBe("1");
    expect(formatCredits(0)).toBe("0");
  });

  it("formatYuanRef 人民币参考价", () => {
    expect(formatYuanRef(1000)).toBe("¥1.00");
    expect(formatYuanRef(325)).toBe("¥0.33");
  });

  it("拒绝负数与小数厘", () => {
    expect(() => formatCredits(-1)).toThrow();
    expect(() => formatCredits(1.5)).toThrow();
  });
});

describe("pricing 价目表", () => {
  it("10 分钟对话 = 30 积分 = ¥3", () => {
    expect(estimateConversationCents(600)).toBe(3000);
    expect(formatYuanRef(3000)).toBe("¥3.00");
  });

  it("各动作单价可查", () => {
    expect(priceOf("review_report").centsPerUnit).toBe(100);
    expect(priceOf("vocab_lecture").unit).toBe("word");
    expect(estimateCents("vocab_lecture", 7)).toBe(70);
    expect(estimateCents("scenario_pack", 1)).toBe(500);
  });

  it("注册赠送 30 积分 ≈ 10 分钟对话", () => {
    expect(SIGNUP_GRANT_CENTS).toBe(estimateConversationCents(600));
  });
});
