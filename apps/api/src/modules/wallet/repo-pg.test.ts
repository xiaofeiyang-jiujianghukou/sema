/**
 * Postgres 仓储单测（pg-mem：内存 Postgres 模拟）
 *
 * 覆盖账本铁律（architecture.md §4）：
 * - 余额 = Σ 账本；appendEntry 原子推进 + 乐观锁并发冲突
 * - 幂等键唯一索引兜底
 * - 用户：手机号唯一、查改
 *
 * ⚠️ pg-mem 是 SQL 逻辑模拟，不是真实 PostgreSQL——部署前需真库跑迁移与冒烟。
 */
import { newDb } from "pg-mem";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { DrizzleUserRepo, DrizzleWalletRepo, BalanceConflictError } from "./repo-pg.js";

const MIGRATION_SQL = readFileSync(
  new URL("../../../../../packages/db/drizzle/0000_sweet_wolfpack.sql", import.meta.url),
  "utf8",
);

let pool: Pool;
let walletRepo: DrizzleWalletRepo;
let userRepo: DrizzleUserRepo;

const testUser = {
  id: "u_pg0000000001",
  phone: "13800009999",
  nickname: "PG用户",
  targetLang: "en" as const,
  passwordHash: null,
  passwordSalt: null,
  createdAtMs: 1_700_000_000_000,
};

beforeAll(() => {
  const mem = newDb();
  mem.public.none(MIGRATION_SQL);
  const { Pool: MemPool } = mem.adapters.createPg();
  pool = new MemPool() as unknown as Pool;
  walletRepo = new DrizzleWalletRepo(pool);
  userRepo = new DrizzleUserRepo(pool);
});

describe("DrizzleWalletRepo（pg-mem）", () => {
  it("getOrCreateWallet 幂等创建，初始余额 0", async () => {
    await userRepo.create(testUser); // wallets.user_id 外键 → users
    const a = await walletRepo.getOrCreateWallet(testUser.id);
    const b = await walletRepo.getOrCreateWallet(testUser.id);
    expect(a).toEqual({ userId: testUser.id, balanceCents: 0 });
    expect(b.balanceCents).toBe(0);
  });

  it("appendEntry 记账 + 余额推进；余额 = Σ 账本", async () => {
    const grant = await walletRepo.appendEntry(
      { userId: testUser.id, type: "grant", amountCents: 3000, reason: "注册体验金", idempotencyKey: "grant:1" },
      3000,
    );
    const charge = await walletRepo.appendEntry(
      { userId: testUser.id, type: "charge", actionCode: "ai_conversation", quantity: 20, unitCents: 5, amountCents: -100, reason: "消费：AI 对话", idempotencyKey: "charge:1" },
      2900,
    );
    expect(grant.balanceAfter).toBe(3000);
    expect(charge.balanceAfter).toBe(2900);

    const wallet = await walletRepo.getOrCreateWallet(testUser.id);
    const entries = await walletRepo.listEntries(testUser.id);
    const sum = entries.reduce((acc, e) => acc + e.amountCents, 0);
    expect(wallet.balanceCents).toBe(sum);
    expect(entries[0]!.id).toBe(charge.id); // 最新在前
  });

  it("期望余额不匹配 → 乐观锁冲突（并发保护）", async () => {
    // 服务层以 getOrCreateWallet 读到的 2900 计算 balanceAfter=2800；
    // 若另一请求已把余额改成 2000，则 UPDATE ... WHERE balance_cents=2900 命中 0 行
    await walletRepo.appendEntry(
      { userId: testUser.id, type: "topup", amountCents: -900, reason: "模拟并发改写" },
      2000,
    );
    await expect(
      walletRepo.appendEntry(
        { userId: testUser.id, type: "charge", actionCode: "ai_conversation", quantity: 20, unitCents: 5, amountCents: -100 },
        2800, // 基于过期的 2900 计算
      ),
    ).rejects.toBeInstanceOf(BalanceConflictError);
  });

  it("幂等键唯一索引兜底：重复记账被拒绝，可按 key 查回", async () => {
    const found = await walletRepo.findByIdempotencyKey("charge:1");
    expect(found?.amountCents).toBe(-100);
    await expect(
      walletRepo.appendEntry(
        { userId: testUser.id, type: "charge", amountCents: -100, idempotencyKey: "charge:1" },
        1900, // 与当前余额一致（2000 - 100），专测幂等键而非乐观锁
      ),
    ).rejects.toThrow("幂等键重复");
  });
});

describe("DrizzleUserRepo（pg-mem）", () => {
  it("创建 + 手机号唯一约束", async () => {
    // 独立手机号：wallet 描述块中 testUser 已建
    await userRepo.create({ ...testUser, id: "u_pg0000000090", phone: "13800009090" });
    const got = await userRepo.get("u_pg0000000090");
    expect(got?.phone).toBe("13800009090");
    expect(got?.nickname).toBe("PG用户");
    expect(got?.createdAtMs).toBe(1_700_000_000_000);
    await expect(userRepo.create({ ...testUser, id: "u_pg0000000091", phone: "13800009090" })).rejects.toThrow("该手机号已注册");
  });

  it("findByPhone / save（改昵称与密码）", async () => {
    const byPhone = await userRepo.findByPhone(testUser.phone);
    expect(byPhone?.id).toBe(testUser.id);
    await userRepo.save({ ...testUser, nickname: "改名了", passwordHash: "h".repeat(128), passwordSalt: "s".repeat(64) });
    const after = await userRepo.get(testUser.id);
    expect(after?.nickname).toBe("改名了");
    expect(after?.passwordHash).toBe("h".repeat(128));
    expect(await userRepo.findByPhone("13900000000")).toBeNull();
  });
});
