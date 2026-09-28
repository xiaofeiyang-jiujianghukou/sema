/**
 * SRS 调度（FSRS-5，经 ts-fsrs 实现）
 *
 * 生词卡的调度状态以可序列化的纯数据存储（PgSQL/内存皆可持久化），
 * 本模块负责「状态 ↔ ts-fsrs Card」映射与打分推进。
 * 请求保留率 0.9（到期即 90% 概率记得的间隔）——语言学习标准配置。
 */
import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card as FsrsCard,
} from "ts-fsrs";

/** 打分：1=忘了 2=费劲 3=顺利 4=轻松 */
export type SrsGrade = 1 | 2 | 3 | 4;

export type SrsCardState = "new" | "learning" | "review" | "relearning";

/** 可持久化的调度状态（全部纯数据） */
export interface SrsState {
  stability: number;
  difficulty: number;
  /** 到期时间（epoch ms） */
  dueMs: number;
  lastReviewMs: number | null;
  reps: number;
  lapses: number;
  state: SrsCardState;
  /** 上次调度出的间隔（天） */
  scheduledDays: number;
}

export function newSrsState(nowMs: number): SrsState {
  return toState(createEmptyCard(new Date(nowMs)));
}

/**
 * 打分推进：给出下一状态。
 * 纯函数——同一输入永远得到同一输出，测试可精确断言。
 */
export function scheduleSrs(prev: SrsState, grade: SrsGrade, nowMs: number): SrsState {
  // 短期学习步（1m/10m）对每日复习的语言词汇噪声大：禁用后首次打分即入天级间隔
  const f = fsrs(generatorParameters({
    request_retention: 0.9,
    enable_fuzz: false,
    learning_steps: [],
    relearning_steps: [],
  }));
  const card: FsrsCard = {
    due: new Date(prev.dueMs),
    stability: prev.stability,
    difficulty: prev.difficulty,
    elapsed_days: 0,
    scheduled_days: prev.scheduledDays,
    reps: prev.reps,
    lapses: prev.lapses,
    state: stateToFsrs(prev.state),
    learning_steps: 0, // 短期步已禁用，步进索引恒为 0
    ...(prev.lastReviewMs === null ? {} : { last_review: new Date(prev.lastReviewMs) }),
  };
  const rating: Rating = grade; // 数值对齐：1=Again 2=Hard 3=Good 4=Easy
  const next = f.repeat(card, new Date(nowMs))[rating].card;
  return toState(next);
}

function toState(card: FsrsCard): SrsState {
  return {
    stability: card.stability,
    difficulty: card.difficulty,
    dueMs: card.due.getTime(),
    lastReviewMs: card.last_review ? card.last_review.getTime() : null,
    reps: card.reps,
    lapses: card.lapses,
    state: stateFromFsrs(card.state),
    scheduledDays: card.scheduled_days,
  };
}

function stateToFsrs(state: SrsCardState): State {
  switch (state) {
    case "new": return State.New;
    case "learning": return State.Learning;
    case "review": return State.Review;
    case "relearning": return State.Relearning;
  }
}

function stateFromFsrs(state: State): SrsCardState {
  switch (state) {
    case State.New: return "new";
    case State.Learning: return "learning";
    case State.Review: return "review";
    case State.Relearning: return "relearning";
  }
}
