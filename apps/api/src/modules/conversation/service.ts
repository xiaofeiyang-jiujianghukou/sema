/**
 * 会话领域服务：情景对话的完整生命周期
 *
 * 计费模型（docs/product.md「按秒累进」）：
 * - 不是结束才结算，而是像水表一样在每个计费点（turn / end）把
 *   「自上次结算以来的秒数」结清——用户中途退出，欠账最多不超过一个 turn
 * - 每个秒段一笔账，幂等键 = sessionId:seq，重复请求不重复扣
 *
 * 内容资产化：opener 是预生成资产，start 阶段 0 成本、即时返回——
 * 用户还没花一分钱就已经「开口」了。
 */
import { CostMeter, TaskRouter } from "@sema/ai-core";
import { priceOf } from "@sema/shared";
import { randomUUID } from "node:crypto";
import { getScenario, type Scenario } from "../../content/scenarios.js";
import type { WalletService } from "../wallet/service.js";
import type { ConversationRepo, ConversationSession } from "./repo.js";

export class ScenarioNotFoundError extends Error {
  readonly code = "SCENARIO_NOT_FOUND" as const;
  constructor(readonly scenarioId: string) {
    super(`情景不存在: ${scenarioId}`);
    this.name = "ScenarioNotFoundError";
  }
}

export class ConversationNotFoundError extends Error {
  readonly code = "CONVERSATION_NOT_FOUND" as const;
  constructor(readonly sessionId: string) {
    super(`会话不存在: ${sessionId}`);
    this.name = "ConversationNotFoundError";
  }
}

export class ConversationEndedError extends Error {
  readonly code = "CONVERSATION_ENDED" as const;
  constructor(readonly sessionId: string) {
    super(`会话已结束: ${sessionId}`);
    this.name = "ConversationEndedError";
  }
}

export interface ConversationPricing {
  code: "ai_conversation";
  unit: "second";
  centsPerSecond: number;
  displayName: string;
  description: string;
}

export function conversationPricing(): ConversationPricing {
  const def = priceOf("ai_conversation");
  return {
    code: "ai_conversation",
    unit: "second",
    centsPerSecond: def.centsPerUnit,
    displayName: def.displayName,
    description: def.description,
  };
}

export interface StartResult {
  sessionId: string;
  scenario: {
    id: string;
    title: string;
    titleEn: string;
    emoji: string;
    difficulty: Scenario["difficulty"];
    setting: string;
    goals: string[];
  };
  opener: string;
  pricing: ConversationPricing;
}

export interface TurnResult {
  sessionId: string;
  reply: string;
  /** 本次请求刚结清的前一段时长（厘，>=0） */
  chargedCents: number;
  balanceCredits: string;
}

export interface EndResult {
  sessionId: string;
  durationSeconds: number;
  turns: number;
  totalBilledCents: number;
  balanceCredits: string;
  /** 分析口径：本次会话的模型成本（人民币） */
  costCny: number;
  /** 结束时的计费明细（每个秒段一笔） */
  billingNote: string;
}

export class ConversationService {
  constructor(
    private readonly repo: ConversationRepo,
    private readonly wallets: WalletService,
    private readonly router: TaskRouter,
    private readonly now: () => number = Date.now,
  ) {}

  async start(userId: string, scenarioId: string): Promise<StartResult> {
    const scenario = getScenario(scenarioId);
    if (!scenario) throw new ScenarioNotFoundError(scenarioId);

    const nowMs = this.now();
    const session: ConversationSession = {
      id: randomUUID(),
      userId,
      scenarioId,
      status: "active",
      startedAtMs: nowMs,
      endedAtMs: null,
      lastBilledAtMs: nowMs,
      billedSeq: 0,
      totalBilledCents: 0,
      history: [
        { role: "system", content: scenario.systemPrompt },
        { role: "assistant", content: scenario.opener },
      ],
      meter: new CostMeter(),
    };
    await this.repo.create(session);

    return {
      sessionId: session.id,
      scenario: {
        id: scenario.id,
        title: scenario.title,
        titleEn: scenario.titleEn,
        emoji: scenario.emoji,
        difficulty: scenario.difficulty,
        setting: scenario.setting,
        goals: scenario.goals,
      },
      opener: scenario.opener,
      pricing: conversationPricing(),
    };
  }

  async turn(sessionId: string, text: string): Promise<TurnResult> {
    const session = await this.mustGet(sessionId);
    if (session.status !== "active") throw new ConversationEndedError(sessionId);

    // 先结清上一段时长，再生成回复——余额不足即在开口前拒绝，欠账永不累积
    const chargedCents = await this.accrue(session);

    session.history.push({ role: "user", content: text });
    const decision = this.router.route("dialogue");
    const result = decision.provider.chat({
      messages: session.history,
      temperature: 0.7,
      maxTokens: 300,
    });

    let reply = "";
    for await (const chunk of result.chunks) reply += chunk;
    const usage = await result.usage();
    session.meter.record(decision.provider.model, usage, {
      tags: { sessionId, task: "dialogue" },
    });
    session.history.push({ role: "assistant", content: reply });

    await this.repo.save(session);
    const wallet = await this.wallets.getWallet(session.userId);

    return {
      sessionId,
      reply,
      chargedCents,
      balanceCredits: wallet.balanceCredits,
    };
  }

  async end(sessionId: string): Promise<EndResult> {
    const session = await this.mustGet(sessionId);
    if (session.status !== "active") throw new ConversationEndedError(sessionId);

    const chargedCents = await this.accrue(session);
    session.status = "ended";
    session.endedAtMs = this.now();
    await this.repo.save(session);

    const wallet = await this.wallets.getWallet(session.userId);
    const turns = session.history.filter((m) => m.role === "user").length;
    const durationSeconds = Math.floor((session.endedAtMs - session.startedAtMs) / 1000);

    return {
      sessionId,
      durationSeconds,
      turns,
      totalBilledCents: session.totalBilledCents,
      balanceCredits: wallet.balanceCredits,
      costCny: session.meter.summary().totalCny,
      billingNote:
        chargedCents > 0
          ? `本次结算 ${chargedCents} 厘（累计 ${session.totalBilledCents} 厘）`
          : `累计已结 ${session.totalBilledCents} 厘`,
    };
  }

  /** 实时快照（进行中的时长/已结金额），供档案页轮询 */
  async snapshot(sessionId: string): Promise<{
    sessionId: string;
    status: ConversationSession["status"];
    scenarioId: string;
    turns: number;
    liveDurationSeconds: number;
    totalBilledCents: number;
  }> {
    const session = await this.mustGet(sessionId);
    const nowMs = this.now();
    const endMs = session.endedAtMs ?? nowMs;
    return {
      sessionId,
      status: session.status,
      scenarioId: session.scenarioId,
      turns: session.history.filter((m) => m.role === "user").length,
      liveDurationSeconds: Math.max(0, Math.floor((endMs - session.startedAtMs) / 1000)),
      totalBilledCents: session.totalBilledCents,
    };
  }

  /** 水表走字：结清自上次结算以来的秒数（每个秒段一笔、幂等） */
  private async accrue(session: ConversationSession): Promise<number> {
    const nowMs = this.now();
    const elapsedSeconds = Math.floor((nowMs - session.lastBilledAtMs) / 1000);
    if (elapsedSeconds <= 0) return 0;

    const { entry } = await this.wallets.charge(
      session.userId,
      "ai_conversation",
      elapsedSeconds,
      {
        relatedId: session.id,
        idempotencyKey: `${session.id}:${session.billedSeq}`,
        reason: "AI 口语对话（按秒累进）",
      },
    );
    session.billedSeq += 1;
    session.lastBilledAtMs += elapsedSeconds * 1000;
    session.totalBilledCents += -entry.amountCents;
    return -entry.amountCents;
  }

  private async mustGet(sessionId: string): Promise<ConversationSession> {
    const session = await this.repo.get(sessionId);
    if (!session) throw new ConversationNotFoundError(sessionId);
    return session;
  }
}
