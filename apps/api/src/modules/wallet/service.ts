import {
  estimateCents,
  formatCredits,
  priceOf,
  type ActionType,
  type CreditCents,
} from "@yanquan/shared";
import type { LedgerEntry, LedgerType, WalletRepo } from "./repo.js";

export class InsufficientFundsError extends Error {
  readonly code = "INSUFFICIENT_FUNDS" as const;
  constructor(
    readonly neededCents: number,
    readonly balanceCents: number,
  ) {
    super(`余额不足：需要 ${neededCents} 厘，当前 ${balanceCents} 厘`);
    this.name = "InsufficientFundsError";
  }
}

export interface ChargeOptions {
  relatedId?: string | undefined;
  idempotencyKey?: string | undefined;
  reason?: string | undefined;
}

export interface MutationResult {
  entry: LedgerEntry;
  /** true = 幂等键命中历史账目，未重复记账 */
  replayed: boolean;
}

/**
 * 钱包领域服务：所有余额变动都从这里走，保证「每笔变动必有账、账本只追加」。
 */
export class WalletService {
  constructor(private readonly repo: WalletRepo) {}

  async getWallet(userId: string) {
    const wallet = await this.repo.getOrCreateWallet(userId);
    const entries = await this.repo.listEntries(userId, 50);
    return {
      userId,
      balanceCents: wallet.balanceCents,
      balanceCredits: formatCredits(wallet.balanceCents),
      entries,
    };
  }

  /** 平台赠送（注册体验金、活动补偿等） */
  async grant(
    userId: string,
    cents: CreditCents,
    reason: string,
    idempotencyKey?: string | undefined,
  ): Promise<MutationResult> {
    if (cents <= 0) throw new Error(`赠送金额必须为正: ${cents}`);
    return this.credit(userId, "grant", cents, reason, idempotencyKey);
  }

  /** 充值入账（M3 接支付回调；M0 由开发通道调用） */
  async topup(
    userId: string,
    cents: CreditCents,
    reason: string,
    opts: { relatedId?: string | undefined; idempotencyKey?: string | undefined } = {},
  ): Promise<MutationResult> {
    if (cents <= 0) throw new Error(`充值金额必须为正: ${cents}`);
    return this.credit(userId, "topup", cents, reason, opts.idempotencyKey, opts.relatedId);
  }

  /** 消费扣减：按价目表计价，余额不足即拒绝 */
  async charge(
    userId: string,
    action: ActionType,
    quantity: number,
    opts: ChargeOptions = {},
  ): Promise<MutationResult> {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`计费数量必须为正数: ${quantity}`);
    }

    const idem = opts.idempotencyKey;
    if (idem) {
      const existing = await this.repo.findByIdempotencyKey(idem);
      if (existing) return { entry: existing, replayed: true };
    }

    const def = priceOf(action);
    const totalCents = estimateCents(action, quantity);
    const wallet = await this.repo.getOrCreateWallet(userId);

    if (wallet.balanceCents < totalCents) {
      throw new InsufficientFundsError(totalCents, wallet.balanceCents);
    }

    const entry = await this.repo.appendEntry(
      {
        userId,
        type: "charge",
        actionCode: action,
        quantity,
        unitCents: def.centsPerUnit,
        amountCents: -totalCents,
        reason: opts.reason ?? `消费：${def.displayName}`,
        relatedId: opts.relatedId,
        idempotencyKey: idem,
      },
      wallet.balanceCents - totalCents,
    );
    return { entry, replayed: false };
  }

  /** 退款：新建 refund 条目回补，绝不修改原账 */
  async refundEntry(
    original: LedgerEntry,
    reason: string,
    idempotencyKey?: string | undefined,
  ): Promise<MutationResult> {
    if (original.amountCents >= 0) throw new Error("只能对扣减条目退款");
    return this.credit(
      original.userId,
      "refund",
      -original.amountCents,
      reason,
      idempotencyKey,
      original.id,
    );
  }

  private async credit(
    userId: string,
    type: LedgerType,
    cents: CreditCents,
    reason: string,
    idempotencyKey?: string | undefined,
    relatedId?: string | undefined,
  ): Promise<MutationResult> {
    if (idempotencyKey) {
      const existing = await this.repo.findByIdempotencyKey(idempotencyKey);
      if (existing) return { entry: existing, replayed: true };
    }
    const wallet = await this.repo.getOrCreateWallet(userId);
    const entry = await this.repo.appendEntry(
      { userId, type, amountCents: cents, reason, relatedId, idempotencyKey },
      wallet.balanceCents + cents,
    );
    return { entry, replayed: false };
  }
}
