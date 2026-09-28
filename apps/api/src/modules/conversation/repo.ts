/**
 * 会话仓储接口 + 内存实现
 *
 * 与钱包仓储同一模式：M0/M1 内存跑通领域逻辑，Postgres 仓储
 * （@sema/db sessions/utterances 表）后续替换注入，领域逻辑不变。
 */
import type { CostMeter } from "@sema/ai-core";
import type { ChatMessage } from "@sema/ai-core";

export type SessionStatus = "active" | "ended";

export interface ConversationSession {
  id: string;
  userId: string;
  scenarioId: string;
  status: SessionStatus;
  startedAtMs: number;
  endedAtMs: number | null;
  /** 计费水位线：上次按秒累进结算到的时刻 */
  lastBilledAtMs: number;
  /** 计费序号（幂等键的一部分，防同一秒段重复记账） */
  billedSeq: number;
  /** 本会话累计已扣积分（厘） */
  totalBilledCents: number;
  /** LLM 对话历史（含 system 与 opener） */
  history: ChatMessage[];
  /** 成本计量器（分析口径，人民币） */
  meter: CostMeter;
}

export interface ConversationRepo {
  create(session: ConversationSession): Promise<void>;
  get(id: string): Promise<ConversationSession | null>;
  save(session: ConversationSession): Promise<void>;
  /** 用户全部会话（学习档案统计用，按开始时间升序） */
  listByUser(userId: string): Promise<ConversationSession[]>;
}

export class MemoryConversationRepo implements ConversationRepo {
  private readonly sessions = new Map<string, ConversationSession>();

  async create(session: ConversationSession): Promise<void> {
    if (this.sessions.has(session.id)) {
      throw new Error(`会话已存在: ${session.id}`);
    }
    this.sessions.set(session.id, session);
  }

  async get(id: string): Promise<ConversationSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async save(session: ConversationSession): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async listByUser(userId: string): Promise<ConversationSession[]> {
    return [...this.sessions.values()]
      .filter((s) => s.userId === userId)
      .sort((a, b) => a.startedAtMs - b.startedAtMs);
  }
}
