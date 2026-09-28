/**
 * 会话/生词/复盘 PG 仓储 pg-mem 单测（模式同 repo-pg.test.ts）
 */
import { newDb } from "pg-mem";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { CostMeter } from "@sema/ai-core";
import { beforeAll, describe, expect, it } from "vitest";
import { PgConversationRepo, PgVocabRepo, PgReviewRepo } from "./repo-pg-domain.js";
import type { ConversationSession } from "../conversation/repo.js";
import type { VocabCard } from "../vocab/service.js";
import type { SessionReview } from "../review/service.js";

const MIGRATION_SQL = readFileSync(
  new URL("../../../../../packages/db/drizzle/0000_wonderful_ghost_rider.sql", import.meta.url),
  "utf8",
);

let pool: Pool;
let conversations: PgConversationRepo;
let vocab: PgVocabRepo;
let reviews: PgReviewRepo;

const USER = "u_pg0000000050";

const makeSession = (): ConversationSession => ({
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  userId: USER,
  scenarioId: "coffee-order",
  status: "active",
  startedAtMs: 1_700_000_000_000,
  endedAtMs: null,
  lastBilledAtMs: 1_700_000_001_000,
  billedSeq: 2,
  totalBilledCents: 150,
  history: [
    { role: "system", content: "sys" },
    { role: "assistant", content: "Morning!" },
    { role: "user", content: "Hi Ben" },
  ],
  meter: CostMeter.from([
    { model: "mock-flagship", usage: { promptTokens: 10, completionTokens: 5 }, cny: 0.001, measured: true, at: "2026-01-01T00:00:00.000Z" },
  ]),
});

const makeCard = (): VocabCard => ({
  id: "vc_pg0000000001",
  userId: USER,
  term: "oat milk",
  translation: "燕麦奶",
  context: "Could I get a latte with oat milk?",
  lang: "en",
  stability: 1.2,
  difficulty: 4.5,
  dueMs: 1_700_010_000_000,
  lastReviewMs: null,
  reps: 0,
  lapses: 0,
  state: "new",
  scheduledDays: 0,
  sourceSessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  createdAtMs: 1_700_000_000_000,
  reviewCount: 0,
  lecture: null,
});

const makeReview = (): SessionReview => ({
  id: "rv_pg0000000001",
  sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  userId: USER,
  scenarioId: "coffee-order",
  createdAtMs: 1_700_000_050_000,
  priceCents: 100,
  corrections: [],
  alternatives: [],
  vocab: [],
  overall: { level: "A2", strengths: "敢开口", focus: "时态" },
} as unknown as SessionReview);

beforeAll(async () => {
  const mem = newDb();
  mem.public.none(MIGRATION_SQL);
  const { Pool: MemPool } = mem.adapters.createPg();
  pool = new MemPool() as unknown as Pool;
  conversations = new PgConversationRepo(pool);
  vocab = new PgVocabRepo(pool);
  reviews = new PgReviewRepo(pool);
  // 外键依赖：建一个真实用户
  await pool.query(
    "INSERT INTO users (id, phone, display_name, target_lang) VALUES ($1, '13800005050', 'PG域用户', 'en')",
    [USER],
  );
});

describe("PgConversationRepo（pg-mem）", () => {
  it("create → get 往返：历史/水位线/成本事件保真", async () => {
    await conversations.create(makeSession());
    const got = await conversations.get(makeSession().id);
    expect(got?.scenarioId).toBe("coffee-order");
    expect(got?.history.length).toBe(3);
    expect(got?.billedSeq).toBe(2);
    expect(got?.totalBilledCents).toBe(150);
    expect(got?.meter.all.length).toBe(1);
    expect(got?.meter.all[0]?.model).toBe("mock-flagship");
  });

  it("save 推进状态；listByUser/deleteByUser 工作", async () => {
    const session = await conversations.get(makeSession().id);
    const ended: ConversationSession = { ...session!, status: "ended", endedAtMs: 1_700_000_100_000 };
    await conversations.save(ended);
    expect((await conversations.get(ended.id))?.status).toBe("ended");

    await conversations.create({ ...makeSession(), id: "7c9e6679-7425-40de-944b-e07fc1f90ae8" });
    expect((await conversations.listByUser(USER)).length).toBe(2);
    expect(await conversations.deleteByUser(USER)).toBe(2);
    expect(await conversations.get(makeSession().id)).toBeNull();
  });
});

describe("PgVocabRepo（pg-mem）", () => {
  it("create → get → save（FSRS 状态保真）", async () => {
    await vocab.create(makeCard());
    const got = await vocab.get(makeCard().id);
    expect(got?.term).toBe("oat milk");
    expect(got?.stability).toBe(1.2);
    expect(got?.state).toBe("new");
    expect(got?.dueMs).toBe(1_700_010_000_000);

    const reviewed: VocabCard = { ...makeCard(), stability: 2.8, state: "review", reps: 1, reviewCount: 1 };
    await vocab.save(reviewed);
    expect((await vocab.get(reviewed.id))?.stability).toBe(2.8);
    expect((await vocab.get(reviewed.id))?.state).toBe("review");
  });

  it("同词去重（唯一索引）+ findByTerm + deleteByUser", async () => {
    await expect(vocab.create({ ...makeCard(), id: "vc_pg0000000002" })).rejects.toThrow("该词已在生词本中");
    expect((await vocab.findByTerm(USER, "  OAT MILK "))?.id).toBe(makeCard().id);
    await vocab.create({ ...makeCard(), id: "vc_pg0000000003", term: "espresso" });
    expect(await vocab.deleteByUser(USER)).toBe(2);
  });
});

describe("PgReviewRepo（pg-mem）", () => {
  it("save → getBySession 幂等取回；listByUser/deleteByUser", async () => {
    await reviews.save(makeReview());
    const got = await reviews.getBySession(makeReview().sessionId);
    expect(got?.overall.level).toBe("A2");
    expect(got?.priceCents).toBe(100);
    expect((await reviews.listByUser(USER)).length).toBe(1);
    expect(await reviews.deleteByUser(USER)).toBe(1);
    expect(await reviews.getBySession(makeReview().sessionId)).toBeNull();
  });
});
