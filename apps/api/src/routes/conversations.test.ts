import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MockLLMProvider, TaskRouter } from "@sema/ai-core";
import { SIGNUP_GRANT_CENTS } from "@sema/shared";
import { buildApp } from "../app.js";

// 可拨动的假时钟
let clockMs: number;

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    now: () => clockMs,
    router: new TaskRouter({
      flagship: new MockLLMProvider("mock-flagship", () => "Sure thing — anything else?"),
      cheap: new MockLLMProvider("mock-cheap"),
    }),
  });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  clockMs = 0;
});

describe("会话 API 冒烟", () => {
  it("情景目录可见且不泄漏 prompt", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/conversations/scenarios" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scenarios.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(body)).not.toContain("systemPrompt");
  });

  it("完整闭环：开始 → 明码标价 → 两轮对话 → 账单", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/wallet/user_c1/grant",
      payload: { cents: SIGNUP_GRANT_CENTS, reason: "注册体验金" },
    });

    const start = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: { userId: "user_c1", scenarioId: "coffee-order" },
    });
    expect(start.statusCode).toBe(201);
    const startBody = start.json();
    expect(startBody.pricing.centsPerSecond).toBe(5);
    expect(startBody.opener).toContain("Morning");
    expect(startBody.scenario.title).toBe("伦敦咖啡店点单");

    clockMs = 20_000;
    const turn1 = await app.inject({
      method: "POST",
      url: `/v1/conversations/${startBody.sessionId}/turns`,
      payload: { text: "Hi Ben, one latte please" },
    });
    expect(turn1.statusCode).toBe(200);
    expect(turn1.json().chargedCents).toBe(100); // 20s × 5厘
    expect(turn1.json().reply).toContain("anything else");

    clockMs = 50_000;
    const turn2 = await app.inject({
      method: "POST",
      url: `/v1/conversations/${startBody.sessionId}/turns`,
      payload: { text: "To go, please. How much is it?" },
    });
    expect(turn2.json().chargedCents).toBe(150); // 30s × 5厘

    clockMs = 56_000;
    const end = await app.inject({
      method: "POST",
      url: `/v1/conversations/${startBody.sessionId}/end`,
    });
    expect(end.statusCode).toBe(200);
    const endBody = end.json();
    expect(endBody.durationSeconds).toBe(56);
    expect(endBody.turns).toBe(2);
    expect(endBody.totalBilledCents).toBe(280); // 56s × 5厘
    expect(endBody.balanceCredits).toBe("27.2"); // 30 - 2.8
    expect(endBody.billingNote).toContain("280");
  });

  it("未知情景 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: { userId: "user_x", scenarioId: "nope" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("SCENARIO_NOT_FOUND");
  });

  it("对话中断网扣费：余额不足 409 且可充值续聊", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/wallet/user_c2/grant",
      payload: { cents: 100, reason: "少量赠送" },
    });
    const start = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: { userId: "user_c2", scenarioId: "lost-in-london" },
    });
    const sessionId = start.json().sessionId;

    clockMs = 30_000;
    const blocked = await app.inject({
      method: "POST",
      url: `/v1/conversations/${sessionId}/turns`,
      payload: { text: "Excuse me..." },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("INSUFFICIENT_FUNDS");

    // 充值后续聊成功（31 秒一并结清 = 155 厘）
    await app.inject({
      method: "POST",
      url: "/v1/wallet/user_c2/topup",
      payload: { cents: 1000, idempotencyKey: "topup_user_c2_1" },
    });
    clockMs = 31_000;
    const resumed = await app.inject({
      method: "POST",
      url: `/v1/conversations/${sessionId}/turns`,
      payload: { text: "Excuse me, how do I get to the tube?" },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().chargedCents).toBe(155);
  });

  it("空消息 400", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/wallet/user_c3/grant",
      payload: { cents: SIGNUP_GRANT_CENTS, reason: "注册体验金" },
    });
    const start = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: { userId: "user_c3", scenarioId: "job-interview" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/conversations/${start.json().sessionId}/turns`,
      payload: { text: "   " },
    });
    expect(res.statusCode).toBe(400);
  });
});
