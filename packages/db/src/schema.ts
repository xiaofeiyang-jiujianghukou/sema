/**
 * 言泉 · 数据库 Schema（PostgreSQL / Drizzle ORM）
 *
 * M0 范围：用户、钱包、追加式账本、价目表快照、学习会话骨架。
 * 生词/FSRS/复盘表在 M2 落地（见 docs/architecture.md §5）。
 *
 * 铁律（docs/architecture.md §4）：
 * - ledger_entries 只追加不修改，退款是新条目
 * - 余额永远 = Σ ledger_entries.amount_cents，每日对账
 */
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    phone: text("phone"),
    wechatOpenid: text("wechat_openid"),
    appleSub: text("apple_sub"),
    displayName: text("display_name").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_phone_uq").on(t.phone)],
);

export const wallets = pgTable("wallets", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  /** 余额（厘）。1 积分 = 100 厘 */
  balanceCents: integer("balance_cents").notNull().default(0),
  /** 乐观锁版本号，并发扣费用 */
  version: integer("version").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 追加式账本：任何余额变动必有账，只写不改 */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** grant | topup | charge | refund */
    type: text("type").notNull(),
    /** 消费动作码（charge 时有值），取值见 @yanquan/shared PRICING */
    actionCode: text("action_code"),
    quantity: integer("quantity"),
    /** 单价（厘），charge 时有值 */
    unitCents: integer("unit_cents"),
    /** 本次变动（厘）：正=入账，负=扣减 */
    amountCents: integer("amount_cents").notNull(),
    /** 变动后余额（厘） */
    balanceAfter: integer("balance_after").notNull(),
    /** 关联对象（如 session_id、IAP 订单号） */
    relatedId: text("related_id"),
    reason: text("reason").notNull().default(""),
    /** 幂等键：支付回调/重试防重复记账 */
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ledger_idem_uq").on(t.idempotencyKey),
    index("ledger_user_idx").on(t.userId, t.createdAt),
  ],
);

/** 价目表快照：@yanquan/shared 是唯一事实源，此处存历史版本供账单追溯 */
export const pricingActions = pgTable("pricing_actions", {
  code: text("code").primaryKey(),
  unit: text("unit").notNull(),
  centsPerUnit: integer("cents_per_unit").notNull(),
  active: integer("active").notNull().default(1),
  description: text("description").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 学习会话（M1 语音对话落地，M0 先立骨架供计费关联） */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    sourceLang: text("source_lang").notNull(),
    targetLang: text("target_lang").notNull(),
    scenarioCode: text("scenario_code").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    centsCharged: integer("cents_charged"),
    /** active | ended | aborted */
    status: text("status").notNull().default("active"),
  },
  (t) => [index("sessions_user_idx").on(t.userId, t.startedAt)],
);
