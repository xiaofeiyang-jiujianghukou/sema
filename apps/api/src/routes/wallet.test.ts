import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SIGNUP_GRANT_CENTS } from "@sema/shared";
import { buildApp } from "../app.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

describe("API 冒烟", () => {
  it("GET /health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.name).toBe("sema");
  });

  it("钱包流：赠送 → 余额 → 消费 → 账单", async () => {
    const grant = await app.inject({
      method: "POST",
      url: "/v1/wallet/user_a/grant",
      payload: { cents: SIGNUP_GRANT_CENTS, reason: "注册体验金" },
    });
    expect(grant.statusCode).toBe(201);
    expect(grant.json().balanceCredits).toBe("30");

    const charge = await app.inject({
      method: "POST",
      url: "/v1/wallet/user_a/charge",
      payload: { action: "ai_conversation", quantity: 65, relatedId: "session_1" },
    });
    expect(charge.statusCode).toBe(200);
    const chargeBody = charge.json();
    expect(chargeBody.amountCents).toBe(-325);
    expect(chargeBody.balanceCredits).toBe("26.75");
    expect(chargeBody.pricing.displayName).toBe("AI 口语对话");

    const wallet = await app.inject({ method: "GET", url: "/v1/wallet/user_a" });
    expect(wallet.statusCode).toBe(200);
    const walletBody = wallet.json();
    expect(walletBody.balanceCents).toBe(2675);
    expect(walletBody.entries).toHaveLength(2);
    expect(walletBody.entries[0]?.amountCents).toBe(-325); // 最新在前
  });

  it("余额不足返回 409 与缺口信息", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/wallet/user_b/grant",
      payload: { cents: 100, reason: "少量赠送" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/wallet/user_b/charge",
      payload: { action: "ai_conversation", quantity: 600 },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("INSUFFICIENT_FUNDS");
    expect(body.error.neededCents).toBe(3000);
    expect(body.error.balanceCents).toBe(100);
  });

  it("幂等：同键重复充值只入账一次", async () => {
    const payload = {
      cents: 5000,
      idempotencyKey: "order_abc_0001",
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/wallet/user_c/topup",
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/wallet/user_c/topup",
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);

    const wallet = await app.inject({ method: "GET", url: "/v1/wallet/user_c" });
    expect(wallet.json().balanceCents).toBe(5000);
  });

  it("参数不合法返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/wallet/user_d/charge",
      payload: { action: "ai_conversation", quantity: -1 },
    });
    expect(res.statusCode).toBe(400);
  });
});
