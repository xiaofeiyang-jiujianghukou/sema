/**
 * 说嘛 · 数据库 Schema（PostgreSQL / Drizzle ORM）
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
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    phone: text("phone"),
    wechatOpenid: text("wechat_openid"),
    appleSub: text("apple_sub"),
    /** 昵称（移动端展示） */
    displayName: text("display_name").notNull().default(""),
    /** 手机号+密码登录：scrypt（N=16384, r=8, p=1）密钥的 hex，64 字节 */
    passwordHash: text("password_hash"),
    /** scrypt 盐，hex，32 字节 */
    passwordSalt: text("password_salt"),
    /** 学习目标语言：en | ja | ko */
    targetLang: text("target_lang").notNull().default("en"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_phone_uq").on(t.phone)],
);

export const wallets = pgTable("wallets", {
  userId: text("user_id")
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
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    /** grant | topup | charge | refund */
    type: text("type").notNull(),
    /** 消费动作码（charge 时有值），取值见 @sema/shared PRICING */
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

/** 价目表快照：@sema/shared 是唯一事实源，此处存历史版本供账单追溯 */
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
    id: text("id").primaryKey(),
    userId: text("user_id")
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
    /** 计费水位线：上次按秒累进结算到的时刻 */
    lastBilledAtMs: timestamp("last_billed_at", { withTimezone: true }).notNull().defaultNow(),
    /** 计费序号（幂等键的一部分） */
    billedSeq: integer("billed_seq").notNull().default(0),
    /** LLM 对话历史（JSON 数组：role/content） */
    history: text("history").notNull().default("[]"),
    /** 成本事件数组（JSON，分析口径） */
    meterEvents: text("meter_events").notNull().default("[]"),
  },
  (t) => [index("sessions_user_idx").on(t.userId, t.startedAt)],
);

/** 生词卡片（FSRS-5 状态 + AI 精讲缓存） */
export const vocabCards = pgTable(
  "vocab_cards",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    term: text("term").notNull(),
    translation: text("translation").notNull(),
    /** 首次学到的上下文句（复盘提取时有值） */
    context: text("context"),
    /** 目标语言：en | ja | ko */
    lang: text("lang").notNull().default("en"),
    /** ts-fsrs Card 序列化（due/stability/difficulty/elapsed_days/...） */
    fsrsState: text("fsrs_state").notNull(),
    dueMs: timestamp("due_ms", { withTimezone: true }).notNull().defaultNow(),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    reviewCount: integer("review_count").notNull().default(0),
    /** AI 精讲缓存（每词一次终身复用）：{definition, examples, nuance, memoryHook, collocations} */
    lecture: text("lecture"),
    lectureGeneratedAt: timestamp("lecture_generated_at", { withTimezone: true }),
    /** 首次入本时间 */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** 出处会话（复盘提取时有值） */
    sourceSessionId: text("source_session_id"),
  },
  (t) => [
    uniqueIndex("vocab_user_term_uq").on(t.userId, t.term),
    index("vocab_due_idx").on(t.userId, t.dueMs),
  ],
);

/** 复盘报告（每次会话一份，幂等键 = 会话 id） */
export const reviewReports = pgTable(
  "review_reports",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    /** 报告 JSON（纠错/地道说法/生词/overall） */
    report: text("report").notNull(),
    priceCents: integer("price_cents").notNull().default(100),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("review_user_idx").on(t.userId, t.createdAt)],
);
