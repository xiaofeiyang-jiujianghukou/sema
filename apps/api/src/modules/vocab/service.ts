/**
 * 生词本——FSRS 间隔复习
 *
 * 卡片来源：复盘报告自动提取 + 手动添加（按 userId+term 去重）。
 * 调度用 @sema/shared 的 FSRS-5 封装；M2 的「生词 AI 精讲」在复习时
 * 按词触发（vocab_lecture 10厘/词），后续接廉价模型。
 */
import { randomUUID } from "node:crypto";
import { newSrsState, scheduleSrs, type SrsGrade, type SrsState } from "@sema/shared";
import { getScenario, type TargetLang } from "../../content/scenarios.js";
import type { SessionReview } from "../review/service.js";

export interface VocabLecture {
  /** 释义（含词性，中文） */
  definition: string;
  /** 目标语地道例句 2-3 条 */
  examples: Array<{ text: string; zh: string }>;
  /** 辨析：与近义词/易混表达的区别（中文） */
  nuance: string;
  /** 记忆钩子：词源/联想/场景锚点（中文） */
  memoryHook: string;
  /** 常见搭配 */
  collocations: string[];
}

export interface VocabCard extends SrsState {
  id: string;
  userId: string;
  term: string;
  translation: string;
  /** 词条所属目标语言（精讲提示词/后续朗读用） */
  lang: TargetLang;
  /** 出处例句（复盘语境或手动输入） */
  context: string | null;
  sourceSessionId: string | null;
  createdAtMs: number;
  /** 复习次数（reps 的镜像，便于统计口径分离） */
  reviewCount: number;
  /** AI 精讲（每词生成一次，缓存终身） */
  lecture: VocabLecture | null;
}

export interface VocabRepo {
  create(card: VocabCard): Promise<void>;
  get(id: string): Promise<VocabCard | null>;
  save(card: VocabCard): Promise<void>;
  findByTerm(userId: string, term: string): Promise<VocabCard | null>;
  listByUser(userId: string): Promise<VocabCard[]>;
  /** 注销账号：删除该用户全部生词卡 */
  deleteByUser(userId: string): Promise<number>;
}

export class MemoryVocabRepo implements VocabRepo {
  private readonly cards = new Map<string, VocabCard>();

  async create(card: VocabCard): Promise<void> {
    if (this.cards.has(card.id)) throw new Error(`卡片已存在: ${card.id}`);
    this.cards.set(card.id, card);
  }

  async get(id: string): Promise<VocabCard | null> {
    return this.cards.get(id) ?? null;
  }

  async save(card: VocabCard): Promise<void> {
    this.cards.set(card.id, card);
  }

  async findByTerm(userId: string, term: string): Promise<VocabCard | null> {
    const key = term.trim().toLowerCase();
    for (const card of this.cards.values()) {
      if (card.userId === userId && card.term.trim().toLowerCase() === key) return card;
    }
    return null;
  }

  async listByUser(userId: string): Promise<VocabCard[]> {
    return [...this.cards.values()]
      .filter((c) => c.userId === userId)
      .sort((a, b) => a.dueMs - b.dueMs);
  }

  async deleteByUser(userId: string): Promise<number> {
    let n = 0;
    for (const [id, c] of this.cards) {
      if (c.userId === userId) {
        this.cards.delete(id);
        n += 1;
      }
    }
    return n;
  }
}

export class VocabCardNotFoundError extends Error {
  readonly code = "VOCAB_CARD_NOT_FOUND";
  constructor(readonly cardId: string) {
    super(`生词卡不存在: ${cardId}`);
  }
}

export interface VocabDeps {
  now: () => number;
}

export interface GradeResult {
  card: VocabCard;
  /** 本次打分是否有效（提前复习有效，重复打分同一到期点会被吞掉） */
  applied: boolean;
}

export class VocabBookService {
  constructor(
    private readonly repo: VocabRepo,
    private readonly deps: VocabDeps = { now: Date.now },
  ) {}

  private now(): number {
    return this.deps.now();
  }

  /** 查词路由用：按词查卡（公开只读透传） */
  async findByTerm(userId: string, term: string): Promise<VocabCard | null> {
    return this.repo.findByTerm(userId, term.trim());
  }

  async add(input: {
    userId: string;
    term: string;
    translation: string;
    lang?: TargetLang;
    context?: string;
    sourceSessionId?: string;
  }): Promise<{ card: VocabCard; created: boolean }> {
    const term = input.term.trim();
    if (term.length === 0) throw new Error("生词不能为空");
    const existing = await this.repo.findByTerm(input.userId, term);
    if (existing) return { card: existing, created: false };

    const card: VocabCard = {
      id: randomUUID(),
      userId: input.userId,
      term,
      translation: input.translation.trim(),
      lang: input.lang ?? "en",
      context: input.context?.trim() || null,
      sourceSessionId: input.sourceSessionId ?? null,
      createdAtMs: this.now(),
      reviewCount: 0,
      lecture: null,
      ...newSrsState(this.now()),
    };
    await this.repo.create(card);
    return { card, created: true };
  }

  /** 复盘报告里的生词批量入本（按 term 去重；语言继承自情景） */
  async addFromReview(review: SessionReview): Promise<{ added: number; duplicates: number }> {
    const lang = getScenario(review.scenarioId)?.targetLang ?? "en";
    let added = 0;
    let duplicates = 0;
    for (const item of review.vocab) {
      const result = await this.add({
        userId: review.userId,
        term: item.term,
        translation: item.translation,
        lang,
        context: item.contextSentence,
        sourceSessionId: review.sessionId,
      });
      if (result.created) added += 1;
      else duplicates += 1;
    }
    return { added, duplicates };
  }

  async list(userId: string): Promise<VocabCard[]> {
    return this.repo.listByUser(userId);
  }

  /** 到期队列：到期时间升序（新卡 due=创建时刻，天然排最前） */
  async due(userId: string, asOfMs?: number): Promise<VocabCard[]> {
    const now = asOfMs ?? this.now();
    const all = await this.repo.listByUser(userId);
    return all.filter((c) => c.dueMs <= now);
  }

  async grade(userId: string, cardId: string, grade: SrsGrade): Promise<GradeResult> {
    const card = await this.repo.get(cardId);
    if (!card || card.userId !== userId) throw new VocabCardNotFoundError(cardId);
    const now = this.now();
    const next = scheduleSrs(card, grade, now);
    const updated: VocabCard = { ...card, ...next, reviewCount: card.reviewCount + 1 };
    await this.repo.save(updated);
    return { card: updated, applied: true };
  }
}
