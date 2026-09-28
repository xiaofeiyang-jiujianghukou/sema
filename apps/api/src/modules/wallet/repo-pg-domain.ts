/**
 * 会话/生词/复盘 Postgres 仓储（pg 原生参数化 SQL，模式同 repo-pg.ts）
 *
 * ⚠️ pg-mem 单测覆盖 SQL 逻辑；真实 PostgreSQL 验证留部署冒烟。
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { CostMeter, type CostEvent } from "@sema/ai-core";
import type { SrsState } from "@sema/shared";
import type { ConversationRepo, ConversationSession } from "../conversation/repo.js";
import type { ReviewRepo, SessionReview } from "../review/service.js";
import type { VocabCard, VocabRepo } from "../vocab/service.js";

/* ════════════════ 会话 ════════════════ */

interface SessionRow {
  id: string;
  user_id: string;
  scenario_code: string;
  status: string;
  started_at: Date;
  ended_at: Date | null;
  last_billed_at: Date;
  billed_seq: number;
  cents_charged: number | null;
  history: string;
  meter_events: string;
}

const rowToSession = (r: SessionRow): ConversationSession => ({
  id: r.id,
  userId: r.user_id,
  scenarioId: r.scenario_code,
  status: r.status as ConversationSession["status"],
  startedAtMs: new Date(r.started_at).getTime(),
  endedAtMs: r.ended_at ? new Date(r.ended_at).getTime() : null,
  lastBilledAtMs: new Date(r.last_billed_at).getTime(),
  billedSeq: r.billed_seq,
  totalBilledCents: r.cents_charged ?? 0,
  history: JSON.parse(r.history) as ConversationSession["history"],
  meter: CostMeter.from(JSON.parse(r.meter_events) as CostEvent[]),
});

export class PgConversationRepo implements ConversationRepo {
  constructor(private readonly pool: Pool) {}

  async create(session: ConversationSession): Promise<void> {
    await this.pool.query(
      "INSERT INTO sessions (id, user_id, source_lang, target_lang, scenario_code, started_at, ended_at, last_billed_at, billed_seq, cents_charged, status, history, meter_events) " +
        "VALUES ($1, $2, 'zh', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
      [
        session.id,
        session.userId,
        "en",
        session.scenarioId,
        new Date(session.startedAtMs),
        session.endedAtMs ? new Date(session.endedAtMs) : null,
        new Date(session.lastBilledAtMs),
        session.billedSeq,
        session.totalBilledCents,
        session.status,
        JSON.stringify(session.history),
        JSON.stringify(session.meter.all),
      ],
    );
  }

  async get(id: string): Promise<ConversationSession | null> {
    const { rows } = await this.pool.query<SessionRow>("SELECT * FROM sessions WHERE id = $1", [id]);
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  async save(session: ConversationSession): Promise<void> {
    await this.pool.query(
      "UPDATE sessions SET status = $2, ended_at = $3, last_billed_at = $4, billed_seq = $5, cents_charged = $6, history = $7, meter_events = $8 WHERE id = $1",
      [
        session.id,
        session.status,
        session.endedAtMs ? new Date(session.endedAtMs) : null,
        new Date(session.lastBilledAtMs),
        session.billedSeq,
        session.totalBilledCents,
        JSON.stringify(session.history),
        JSON.stringify(session.meter.all),
      ],
    );
  }

  async listByUser(userId: string): Promise<ConversationSession[]> {
    const { rows } = await this.pool.query<SessionRow>(
      "SELECT * FROM sessions WHERE user_id = $1 ORDER BY started_at ASC",
      [userId],
    );
    return rows.map(rowToSession);
  }

  async deleteByUser(userId: string): Promise<number> {
    const { rowCount } = await this.pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    return rowCount ?? 0;
  }
}

/* ════════════════ 生词 ════════════════ */

interface CardRow {
  id: string;
  user_id: string;
  term: string;
  translation: string;
  context: string | null;
  lang: string;
  fsrs_state: string;
  due_ms: Date;
  reps: number;
  lapses: number;
  review_count: number;
  lecture: string | null;
  created_at: Date;
  source_session_id: string | null;
}

const rowToCard = (r: CardRow): VocabCard => {
  const srs = JSON.parse(r.fsrs_state) as SrsState;
  return {
    ...srs,
    dueMs: new Date(r.due_ms).getTime(), // due_ms 列为索引权威，与 JSON 同步写
    id: r.id,
    userId: r.user_id,
    term: r.term,
    translation: r.translation,
    context: r.context,
    lang: r.lang as VocabCard["lang"],
    sourceSessionId: r.source_session_id,
    createdAtMs: new Date(r.created_at).getTime(),
    reviewCount: r.review_count,
    lecture: r.lecture ? (JSON.parse(r.lecture) as VocabCard["lecture"]) : null,
  };
};

const cardToSrs = (card: VocabCard): SrsState => ({
  stability: card.stability,
  difficulty: card.difficulty,
  dueMs: card.dueMs,
  lastReviewMs: card.lastReviewMs,
  reps: card.reps,
  lapses: card.lapses,
  state: card.state,
  scheduledDays: card.scheduledDays,
});

export class PgVocabRepo implements VocabRepo {
  constructor(private readonly pool: Pool) {}

  async create(card: VocabCard): Promise<void> {
    try {
      await this.pool.query(
        "INSERT INTO vocab_cards (id, user_id, term, translation, context, lang, fsrs_state, due_ms, reps, lapses, review_count, lecture, created_at, source_session_id) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
        [
          card.id,
          card.userId,
          card.term,
          card.translation,
          card.context ?? null,
          card.lang,
          JSON.stringify(cardToSrs(card)),
          new Date(card.dueMs),
          card.reps,
          card.lapses,
          card.reviewCount,
          card.lecture ? JSON.stringify(card.lecture) : null,
          new Date(card.createdAtMs),
          card.sourceSessionId ?? null,
        ],
      );
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
        throw new Error("该词已在生词本中");
      }
      throw err;
    }
  }

  async get(id: string): Promise<VocabCard | null> {
    const { rows } = await this.pool.query<CardRow>("SELECT * FROM vocab_cards WHERE id = $1", [id]);
    return rows[0] ? rowToCard(rows[0]) : null;
  }

  async save(card: VocabCard): Promise<void> {
    await this.pool.query(
      "UPDATE vocab_cards SET fsrs_state = $2, due_ms = $3, reps = $4, lapses = $5, review_count = $6, lecture = $7 WHERE id = $1", // created_at/source_session_id 不变
      [
        card.id,
        JSON.stringify(cardToSrs(card)),
        new Date(card.dueMs),
        card.reps,
        card.lapses,
        card.reviewCount,
        card.lecture ? JSON.stringify(card.lecture) : null,
      ],
    );
  }

  async findByTerm(userId: string, term: string): Promise<VocabCard | null> {
    const { rows } = await this.pool.query<CardRow>(
      "SELECT * FROM vocab_cards WHERE user_id = $1 AND lower(term) = lower($2)",
      [userId, term.trim()],
    );
    return rows[0] ? rowToCard(rows[0]) : null;
  }

  async listByUser(userId: string): Promise<VocabCard[]> {
    const { rows } = await this.pool.query<CardRow>(
      "SELECT * FROM vocab_cards WHERE user_id = $1 ORDER BY due_ms ASC",
      [userId],
    );
    return rows.map(rowToCard);
  }

  async deleteByUser(userId: string): Promise<number> {
    const { rowCount } = await this.pool.query("DELETE FROM vocab_cards WHERE user_id = $1", [userId]);
    return rowCount ?? 0;
  }
}



/* ════════════════ 复盘 ════════════════ */

interface ReviewRow {
  id: string;
  session_id: string;
  user_id: string;
  report: string;
  price_cents: number;
  created_at: Date;
}

export class PgReviewRepo implements ReviewRepo {
  constructor(private readonly pool: Pool) {}

  async save(review: SessionReview): Promise<void> {
    await this.pool.query(
      "INSERT INTO review_reports (id, session_id, user_id, report, price_cents) VALUES ($1, $2, $3, $4, $5)",
      [review.id, review.sessionId, review.userId, JSON.stringify(review), review.priceCents],
    );
  }

  async getBySession(sessionId: string): Promise<SessionReview | null> {
    const { rows } = await this.pool.query<ReviewRow>("SELECT * FROM review_reports WHERE session_id = $1", [sessionId]);
    return rows[0] ? (JSON.parse(rows[0].report) as SessionReview) : null;
  }

  async listByUser(userId: string): Promise<SessionReview[]> {
    const { rows } = await this.pool.query<ReviewRow>(
      "SELECT * FROM review_reports WHERE user_id = $1 ORDER BY created_at ASC",
      [userId],
    );
    return rows.map((r) => JSON.parse(r.report) as SessionReview);
  }

  async deleteByUser(userId: string): Promise<number> {
    const { rowCount } = await this.pool.query("DELETE FROM review_reports WHERE user_id = $1", [userId]);
    return rowCount ?? 0;
  }
}

/** 会话 id 由服务层 randomUUID 生成，此处仅供内部兜底使用 */
export const newSessionId = (): string => randomUUID();
