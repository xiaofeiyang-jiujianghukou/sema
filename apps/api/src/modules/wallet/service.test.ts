import { beforeEach, describe, expect, it } from "vitest";
import { SIGNUP_GRANT_CENTS } from "@sema/shared";
import { MemoryWalletRepo } from "./repo.js";
import { InsufficientFundsError, WalletService } from "./service.js";

let service: WalletService;

beforeEach(() => {
  service = new WalletService(new MemoryWalletRepo());
});

describe("WalletService 账本核心", () => {
  it("注册赠送 → 余额与账单各一笔", async () => {
    await service.grant("u1", SIGNUP_GRANT_CENTS, "注册体验金");
    const w = await service.getWallet("u1");
    expect(w.balanceCents).toBe(3000);
    expect(w.balanceCredits).toBe("30");
    expect(w.entries).toHaveLength(1);
    expect(w.entries[0]?.balanceAfter).toBe(3000);
  });

  it("对话消费：65 秒扣 325 厘，余额联动", async () => {
    await service.grant("u1", 3000, "注册体验金");
    const { entry } = await service.charge("u1", "ai_conversation", 65, {
      relatedId: "session_1",
    });
    expect(entry.amountCents).toBe(-325);
    expect(entry.balanceAfter).toBe(2675);
    expect(entry.actionCode).toBe("ai_conversation");
    expect(entry.unitCents).toBe(5);
  });

  it("余额不足拒绝扣费且不产生账目", async () => {
    await service.grant("u1", 100, "少量赠送");
    await expect(service.charge("u1", "ai_conversation", 60)).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );
    const w = await service.getWallet("u1");
    expect(w.balanceCents).toBe(100);
    expect(w.entries).toHaveLength(1);
  });

  it("幂等键：重复请求只记一笔账", async () => {
    await service.grant("u1", 3000, "注册体验金");
    const key = "iap_order_123";
    const first = await service.topup("u1", 5000, "充值 ¥5", {
      idempotencyKey: key,
    });
    const second = await service.topup("u1", 5000, "充值 ¥5", {
      idempotencyKey: key,
    });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    const w = await service.getWallet("u1");
    expect(w.balanceCents).toBe(8000); // 3000 + 5000，没有重复入账
  });

  it("退款是新条目，原账不可变", async () => {
    await service.grant("u1", 3000, "注册体验金");
    const { entry } = await service.charge("u1", "scenario_pack", 1);
    expect(entry.amountCents).toBe(-500);
    await service.refundEntry(entry, "内容问题退款");
    const w = await service.getWallet("u1");
    expect(w.balanceCents).toBe(3000);
    expect(w.entries).toHaveLength(3); // grant, charge, refund
    expect(w.entries.every((e, i, arr) => i === 0 || arr[i - 1] !== e)).toBe(true);
  });

  it("账本链：balanceAfter 与 Σ amountCents 恒等（对账铁律）", async () => {
    await service.grant("u1", 3000, "注册体验金");
    await service.charge("u1", "ai_conversation", 95);
    await service.charge("u1", "vocab_lecture", 7);
    await service.topup("u1", 1000, "充值 ¥1", { idempotencyKey: "topup_a1" });
    await service.charge("u1", "review_report", 1);

    const w = await service.getWallet("u1");
    const sum = w.entries.reduce((acc, e) => acc + e.amountCents, 0);
    expect(w.balanceCents).toBe(sum);
    const last = w.entries[0]; // 最新在前
    expect(last?.balanceAfter).toBe(w.balanceCents);
  });

  it("非法计费数量被拒绝", async () => {
    await service.grant("u1", 3000, "注册体验金");
    await expect(service.charge("u1", "ai_conversation", 0)).rejects.toThrow();
    await expect(service.charge("u1", "ai_conversation", -5)).rejects.toThrow();
  });
});
