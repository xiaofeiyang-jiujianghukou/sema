import { beforeEach, describe, expect, it } from "vitest";
import { MockLLMProvider, TaskRouter } from "@sema/ai-core";
import { SIGNUP_GRANT_CENTS } from "@sema/shared";
import { MemoryWalletRepo } from "../wallet/repo.js";
import { WalletService } from "../wallet/service.js";
import { MemoryConversationRepo } from "./repo.js";
import { ConversationEndedError, ConversationService, ScenarioNotFoundError } from "./service.js";
import { InsufficientFundsError } from "../wallet/service.js";

// 可拨动的假时钟（毫秒）
let clockMs: number;
const now = () => clockMs;

let wallets: WalletService;
let conversations: ConversationService;

beforeEach(() => {
  clockMs = 0;
  wallets = new WalletService(new MemoryWalletRepo());
  conversations = new ConversationService(
    new MemoryConversationRepo(),
    wallets,
    new TaskRouter({
      flagship: new MockLLMProvider("mock-flagship", () => "Great! Tell me more."),
      cheap: new MockLLMProvider("mock-cheap"),
    }),
    now,
  );
});

async function grantFor(userId: string, cents: number): Promise<void> {
  await wallets.grant(userId, cents, "测试赠送");
}

describe("会话服务：start 与内容资产", () => {
  it("opener 是预生成资产：start 不花一分钱、不调模型", async () => {
    await grantFor("u1", SIGNUP_GRANT_CENTS);
    const result = await conversations.start("u1", "coffee-order");
    expect(result.opener).toContain("what can I get started");
    expect(result.pricing.centsPerSecond).toBe(5);
    expect(result.scenario.goals.length).toBeGreaterThanOrEqual(3);

    const snap = await conversations.snapshot(result.sessionId);
    expect(snap.status).toBe("active");
    expect(snap.turns).toBe(0);
    expect(snap.totalBilledCents).toBe(0);
  });

  it("未知情景抛 ScenarioNotFoundError", async () => {
    await expect(conversations.start("u1", "nope")).rejects.toBeInstanceOf(ScenarioNotFoundError);
  });
});

describe("会话服务：按交互计费（说话才计时，闲置不扣）", () => {
  it("文字轮每轮固定 10 厘；开场白与挂机零扣费；结束不再结算", async () => {
    await grantFor("u1", SIGNUP_GRANT_CENTS);

    const started = await conversations.start("u1", "coffee-order");
    expect(started.opener.length).toBeGreaterThan(0); // 开场白免费

    clockMs = 30_000; // 开场后闲置 30 秒——不计费
    const turn1 = await conversations.turn(started.sessionId, "One latte please");
    expect(turn1.chargedCents).toBe(10); // ai_text_turn 10 厘/轮
    expect(turn1.balanceCredits).toBe("29.9");
    expect(turn1.reply.length).toBeGreaterThan(0);

    clockMs = 95_000; // 闲置 65 秒也不计费
    const turn2 = await conversations.turn(started.sessionId, "For here, please");
    expect(turn2.chargedCents).toBe(10);

    clockMs = 100_000;
    const ended = await conversations.end(started.sessionId);
    expect(ended.durationSeconds).toBe(100);
    expect(ended.turns).toBe(2);
    expect(ended.totalBilledCents).toBe(20); // 只有两轮交互的钱
    expect(ended.balanceCredits).toBe("29.8");
    expect(ended.costCny).toBe(0); // mock 供应商零成本
  });

  it("语音轮按实际说话秒数计费（向上取整），与挂钟无关", async () => {
    await grantFor("u1v", SIGNUP_GRANT_CENTS);
    const started = await conversations.start("u1v", "coffee-order");

    clockMs = 600_000; // 开场后挂机 10 分钟
    const turn = await conversations.turnVoice(started.sessionId, "Hello!", 4.2);
    expect(turn.chargedCents).toBe(25); // ceil(4.2)=5s × 5厘——与 10 分钟挂机无关
  });

  it("余额不足：开口前就被拦下，欠账不累积", async () => {
    await grantFor("u2", 5); // 不够一轮 10 厘

    const started = await conversations.start("u2", "coffee-order");
    await expect(conversations.turn(started.sessionId, "Hi")).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );

    const snap = await conversations.snapshot(started.sessionId);
    expect(snap.totalBilledCents).toBe(0);

    // 充值后原样继续（每轮 10 厘）
    await grantFor("u2", 1000);
    const turn = await conversations.turn(started.sessionId, "Hi");
    expect(turn.chargedCents).toBe(10);
  });

  it("结束后再 turn / end 都被拒绝", async () => {
    await grantFor("u3", SIGNUP_GRANT_CENTS);
    const started = await conversations.start("u3", "coffee-order");
    await conversations.turn(started.sessionId, "Hello");
    await conversations.end(started.sessionId);

    await expect(conversations.turn(started.sessionId, "again")).rejects.toBeInstanceOf(
      ConversationEndedError,
    );
    await expect(conversations.end(started.sessionId)).rejects.toBeInstanceOf(
      ConversationEndedError,
    );
  });

  it("未知会话抛 CONVERSATION_NOT_FOUND", async () => {
    await expect(conversations.turn("ghost", "hi")).rejects.toMatchObject({
      code: "CONVERSATION_NOT_FOUND",
    });
  });
});
