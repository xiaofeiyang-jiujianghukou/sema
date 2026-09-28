/**
 * Postgres 仓储实现（pg 原生参数化 SQL）
 *
 * 与内存实现实现同一批接口（WalletRepo / UserRepo），由 app.ts 按环境装配：
 * - 未配置 DATABASE_URL → 内存实现（开发/测试）
 * - 配置 DATABASE_URL → Postgres 实现（生产）
 * 建表迁移由 drizzle-kit 生成（packages/db/drizzle/*.sql），运行时不依赖 ORM。
 *
 * 账本铁律（architecture.md §4）在 appendEntry 中以**单事务 + 期望余额校验**落地：
 * UPDATE wallets ... WHERE balance_cents = 期望前值（乐观锁），影响行数为 0 即并发冲突。
 *
 * ⚠️ 诚实边界：单测用 pg-mem（内存 Postgres 模拟）验证 SQL 与事务逻辑，
 * 未在真实 PostgreSQL 上验证——部署前需用真实库跑一遍迁移与冒烟。
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { LedgerEntry, LedgerEntryInput, WalletRepo, WalletSnapshot } from "./repo.js";
import type { UserAccount, UserRepo } from "../auth/service.js";

export class BalanceConflictError extends Error {
  constructor(readonly userId: string) {
    super(`钱包余额并发冲突: ${userId}`);
    this.name = "BalanceConflictError";
  }
}

interface LedgerRow {
  id: string;
  user_id: string;
  type: string;
  action_code: string | null;
  quantity: number | null;
  unit_cents: number | null;
  amount_cents: number;
  balance_after: number;
  related_id: string | null;
  reason: string;
  idempotency_key: string | null;
  created_at: Date;
}

const rowToEntry = (r: LedgerRow): LedgerEntry => ({
  id: r.id,
  userId: r.user_id,
  type: r.type as LedgerEntry["type"],
  actionCode: r.action_code,
  quantity: r.quantity,
  unitCents: r.unit_cents,
  amountCents: r.amount_cents,
  balanceAfter: r.balance_after,
  relatedId: r.related_id,
  reason: r.reason,
  idempotencyKey: r.idempotency_key,
  createdAt: new Date(r.created_at).toISOString(),
});

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";

export class DrizzleWalletRepo implements WalletRepo {
  constructor(private readonly pool: Pool) {}

  async getOrCreateWallet(userId: string): Promise<WalletSnapshot> {
    await this.pool.query(
      "INSERT INTO wallets (user_id, balance_cents, version) VALUES ($1, 0, 0) ON CONFLICT DO NOTHING",
      [userId],
    );
    const { rows } = await this.pool.query<{ balance_cents: number }>(
      "SELECT balance_cents FROM wallets WHERE user_id = $1",
      [userId],
    );
    if (rows.length === 0) throw new Error(`钱包创建失败: ${userId}`);
    return { userId, balanceCents: rows[0]!.balance_cents };
  }

  async appendEntry(input: LedgerEntryInput, balanceAfter: number): Promise<LedgerEntry> {
    const balanceBefore = balanceAfter - input.amountCents;
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const upd = await client.query<{ balance_cents: number }>(
        "UPDATE wallets SET balance_cents = $1, version = version + 1, updated_at = now() " +
          "WHERE user_id = $2 AND balance_cents = $3 RETURNING balance_cents",
        [balanceAfter, input.userId, balanceBefore],
      );
      if (upd.rowCount === 0) throw new BalanceConflictError(input.userId);

      const ins = await client.query<LedgerRow>(
        "INSERT INTO ledger_entries " +
          "(id, user_id, type, action_code, quantity, unit_cents, amount_cents, balance_after, related_id, reason, idempotency_key) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *",
        [
          `le_${randomUUID()}`,
          input.userId,
          input.type,
          input.actionCode ?? null,
          input.quantity ?? null,
          input.unitCents ?? null,
          input.amountCents,
          balanceAfter,
          input.relatedId ?? null,
          input.reason ?? "",
          input.idempotencyKey ?? null,
        ],
      );
      await client.query("COMMIT");
      committed = true;
      return rowToEntry(ins.rows[0]!);
    } catch (err) {
      if (!committed) await client.query("ROLLBACK").catch(() => undefined);
      if (isUniqueViolation(err)) throw new Error(`幂等键重复: ${input.idempotencyKey}`);
      throw err;
    } finally {
      client.release();
    }
  }

  async listEntries(userId: string, limit = 50): Promise<LedgerEntry[]> {
    const { rows } = await this.pool.query<LedgerRow>(
      "SELECT * FROM ledger_entries WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
      [userId, limit],
    );
    return rows.map(rowToEntry);
  }

  async findByIdempotencyKey(key: string): Promise<LedgerEntry | null> {
    const { rows } = await this.pool.query<LedgerRow>(
      "SELECT * FROM ledger_entries WHERE idempotency_key = $1",
      [key],
    );
    return rows[0] ? rowToEntry(rows[0]) : null;
  }

  /** 注销：删钱包；账本 user_id 去标识留存（财务记录不关联个人） */
  async deleteByUser(userId: string): Promise<{ walletDeleted: boolean; ledgerAnonymized: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const anon = await client.query<{ user_id: string }>(
        "UPDATE ledger_entries SET user_id = 'deleted:' || $1, reason = reason WHERE user_id = $1 RETURNING id",
        [userId],
      );
      const del = await client.query("DELETE FROM wallets WHERE user_id = $1", [userId]);
      await client.query("COMMIT");
      return { walletDeleted: (del.rowCount ?? 0) > 0, ledgerAnonymized: anon.rowCount ?? 0 };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

interface UserRow {
  id: string;
  phone: string | null;
  display_name: string;
  target_lang: string | null;
  password_hash: string | null;
  password_salt: string | null;
  created_at: Date;
}

const rowToUser = (r: UserRow): UserAccount => ({
  id: r.id,
  phone: r.phone ?? "",
  nickname: r.display_name,
  targetLang: (r.target_lang as UserAccount["targetLang"]) ?? "en",
  passwordHash: r.password_hash,
  passwordSalt: r.password_salt,
  createdAtMs: new Date(r.created_at).getTime(),
});

export class DrizzleUserRepo implements UserRepo {
  constructor(private readonly pool: Pool) {}

  async create(user: UserAccount): Promise<void> {
    try {
      await this.pool.query(
        "INSERT INTO users (id, phone, display_name, target_lang, password_hash, password_salt, created_at) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [
          user.id,
          user.phone,
          user.nickname,
          user.targetLang,
          user.passwordHash,
          user.passwordSalt,
          new Date(user.createdAtMs),
        ],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new Error("该手机号已注册");
      throw err;
    }
  }

  async get(id: string): Promise<UserAccount | null> {
    const { rows } = await this.pool.query<UserRow>(
      "SELECT id, phone, display_name, target_lang, password_hash, password_salt, created_at FROM users WHERE id = $1",
      [id],
    );
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async findByPhone(phone: string): Promise<UserAccount | null> {
    const { rows } = await this.pool.query<UserRow>(
      "SELECT id, phone, display_name, target_lang, password_hash, password_salt, created_at FROM users WHERE phone = $1",
      [phone],
    );
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async save(user: UserAccount): Promise<void> {
    await this.pool.query(
      "UPDATE users SET display_name = $2, target_lang = $3, password_hash = $4, password_salt = $5 WHERE id = $1",
      [user.id, user.nickname, user.targetLang, user.passwordHash, user.passwordSalt],
    );
  }

  async delete(id: string): Promise<void> {
    await this.pool.query("DELETE FROM users WHERE id = $1", [id]);
  }
}
