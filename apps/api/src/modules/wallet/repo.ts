/**
 * 钱包仓储接口 + 内存实现
 *
 * M0 用内存实现跑通领域逻辑与 API；接 Postgres 时新增 DrizzleWalletRepo：
 * - getOrCreateWallet: INSERT ... ON CONFLICT DO NOTHING 后 SELECT
 * - appendEntry: 单事务内 UPDATE wallets(乐观锁/余额校验) + INSERT ledger_entries
 * - 幂等键由 ledger_entries.idempotency_key 唯一索引兜底
 */

export type LedgerType = "grant" | "topup" | "charge" | "refund";

export interface LedgerEntryInput {
  userId: string;
  type: LedgerType;
  actionCode?: string | undefined;
  quantity?: number | undefined;
  unitCents?: number | undefined;
  /** 正=入账，负=扣减（厘） */
  amountCents: number;
  reason?: string | undefined;
  relatedId?: string | undefined;
  idempotencyKey?: string | undefined;
}

export interface LedgerEntry {
  id: string;
  userId: string;
  type: LedgerType;
  actionCode: string | null;
  quantity: number | null;
  unitCents: number | null;
  amountCents: number;
  balanceAfter: number;
  relatedId: string | null;
  reason: string;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface WalletSnapshot {
  userId: string;
  balanceCents: number;
}

export interface WalletRepo {
  getOrCreateWallet(userId: string): Promise<WalletSnapshot>;
  /** 追加一条账目并把余额推进到 balanceAfter（真实实现须原子） */
  appendEntry(input: LedgerEntryInput, balanceAfter: number): Promise<LedgerEntry>;
  /** 最新在前 */
  listEntries(userId: string, limit?: number): Promise<LedgerEntry[]>;
  findByIdempotencyKey(key: string): Promise<LedgerEntry | null>;
  /** 注销账号：删除钱包；账本去标识留存（财务记录不关联个人） */
  deleteByUser(userId: string): Promise<{ walletDeleted: boolean; ledgerAnonymized: number }>;
}

export class MemoryWalletRepo implements WalletRepo {
  private balances = new Map<string, number>();
  private entries = new Map<string, LedgerEntry[]>();
  private byIdem = new Map<string, LedgerEntry>();
  private seq = 0;

  async getOrCreateWallet(userId: string): Promise<WalletSnapshot> {
    if (!this.balances.has(userId)) {
      this.balances.set(userId, 0);
      this.entries.set(userId, []);
    }
    return { userId, balanceCents: this.balances.get(userId) as number };
  }

  async appendEntry(input: LedgerEntryInput, balanceAfter: number): Promise<LedgerEntry> {
    if (input.idempotencyKey && this.byIdem.has(input.idempotencyKey)) {
      throw new Error(`幂等键重复: ${input.idempotencyKey}`);
    }
    const entry: LedgerEntry = {
      id: `le_${String(++this.seq).padStart(8, "0")}`,
      userId: input.userId,
      type: input.type,
      actionCode: input.actionCode ?? null,
      quantity: input.quantity ?? null,
      unitCents: input.unitCents ?? null,
      amountCents: input.amountCents,
      balanceAfter,
      relatedId: input.relatedId ?? null,
      reason: input.reason ?? "",
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: new Date().toISOString(),
    };
    this.balances.set(input.userId, balanceAfter);
    (this.entries.get(input.userId) as LedgerEntry[]).push(entry);
    if (input.idempotencyKey) this.byIdem.set(input.idempotencyKey, entry);
    return entry;
  }

  async listEntries(userId: string, limit = 50): Promise<LedgerEntry[]> {
    const all = this.entries.get(userId) ?? [];
    return [...all].reverse().slice(0, limit);
  }

  async findByIdempotencyKey(key: string): Promise<LedgerEntry | null> {
    return this.byIdem.get(key) ?? null;
  }

  /** 内存实现（开发/测试）：直接删除。PG 生产实现做账本去标识留存 */
  async deleteByUser(userId: string): Promise<{ walletDeleted: boolean; ledgerAnonymized: number }> {
    const had = this.balances.delete(userId);
    this.entries.delete(userId);
    return { walletDeleted: had, ledgerAnonymized: 0 };
  }
}
