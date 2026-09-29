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

export class ConversationForbiddenError extends Error {
  readonly code = "CONVERSATION_FORBIDDEN" as const;
  constructor(readonly sessionId: string) {
    super(`会话不属于当前用户: ${sessionId}`);
    this.name = "ConversationForbiddenError";
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
    targetLang: Scenario["targetLang"];
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
  /** 零基础/入门模式：AI 回复的中文翻译（正文之后的「译：」行） */
  translation?: string;
  /** 零基础模式：建议用户此刻说的一句目标语言（「说：」行） */
  suggestion?: string;
  /** 本次请求刚结清的前一段时长（厘，>=0） */
  chargedCents: number;
  balanceCredits: string;
}

/** 剥离「译：」「说：」脚手架标记行（兼容全角/半角冒号） */
export function splitScaffolding(raw: string): { reply: string; translation: string | null; suggestion: string | null } {
  let translation: string | null = null;
  let suggestion: string | null = null;
  const body: string[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^译[:：]/.test(line)) {
      const t = line.replace(/^译[:：]\s*/, "").trim();
      if (t) translation = t;
    } else if (/^说[:：]/.test(line)) {
      const t = line.replace(/^说[:：]\s*/, "").trim();
      if (t) suggestion = t;
    } else {
      body.push(line);
    }
  }
  return { reply: body.join("\n").trim() || raw.trim(), translation, suggestion };
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
    /** 学习者水平（未注入按 basic 处理）：按（用户，语言）取——每门课各自的水平 */
    private readonly getUserLevel?: (userId: string, lang: string) => Promise<"zero" | "basic" | "pro" | undefined>,
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
        targetLang: scenario.targetLang,
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

  /** 语音通道复用已有会话（归属 + 状态校验）；不重放开场白 TTS，由调用方决定 */
  async resumeVoice(userId: string, sessionId: string): Promise<StartResult> {
    const session = await this.repo.get(sessionId);
    if (!session) throw new ConversationNotFoundError(sessionId);
    if (session.userId !== userId) throw new ConversationForbiddenError(sessionId);
    if (session.status !== "active") throw new ConversationEndedError(sessionId);
    const scenario = getScenario(session.scenarioId);
    if (!scenario) throw new ScenarioNotFoundError(session.scenarioId);
    const opener = session.history.find((h) => h.role === "assistant")?.content ?? scenario.opener;
    return {
      sessionId: session.id,
      scenario: {
        id: scenario.id,
        targetLang: scenario.targetLang,
        title: scenario.title,
        titleEn: scenario.titleEn,
        emoji: scenario.emoji,
        difficulty: scenario.difficulty,
        setting: scenario.setting,
        goals: scenario.goals,
      },
      opener,
      pricing: conversationPricing(),
    };
  }

  /** 文字轮次：每轮固定 10 厘（开口前扣费，余额不足即拒绝，欠账永不累积） */
  async turn(sessionId: string, text: string): Promise<TurnResult> {
    const session = await this.mustGet(sessionId);
    if (session.status !== "active") throw new ConversationEndedError(sessionId);
    const { entry } = await this.wallets.charge(session.userId, "ai_text_turn", 1, {
      relatedId: sessionId,
      idempotencyKey: `${sessionId}:t${session.billedSeq += 1}`,
    });
    const chargedCents = -entry.amountCents; // 扣费条目为负数，对外报正数
    session.totalBilledCents += chargedCents;
    return this.dialogue(session, text, chargedCents);
  }

  /** 语音轮次：按用户本段实际说话的秒数计费（5 厘/秒，向上取整；静音不计费） */
  async turnVoice(sessionId: string, text: string, speechSeconds: number): Promise<TurnResult> {
    const session = await this.mustGet(sessionId);
    if (session.status !== "active") throw new ConversationEndedError(sessionId);
    const seconds = Math.max(1, Math.ceil(speechSeconds));
    const { entry } = await this.wallets.charge(session.userId, "ai_conversation", seconds, {
      relatedId: sessionId,
      idempotencyKey: `${sessionId}:t${session.billedSeq += 1}`,
    });
    const chargedCents = -entry.amountCents;
    session.totalBilledCents += chargedCents;
    return this.dialogue(session, text, chargedCents);
  }

  private async dialogue(session: ConversationSession, text: string, chargedCents: number): Promise<TurnResult> {
    const sessionId = session.id;

    session.history.push({ role: "user", content: text });
    const decision = this.router.route("dialogue");

    // 学习者水平脚手架：只影响本次调用的额外 system 指令，不写入历史。
    // 水平按情景语言取——同一用户英语进阶、日语可以零基础
    const lang = getScenario(session.scenarioId)?.targetLang ?? "en";
    const level = this.getUserLevel ? await this.getUserLevel(session.userId, lang) : undefined;
    const scaffold =
      level === "zero"
        ? [
            "【零基础学习者模式，必须遵守】",
            "- 用户几乎不认识这门语言：回复最多两句，只用最基础的 A1 词汇，短句，一次只问一个问题。",
            "- 正文后另起一行，以「译：」开头给出你整段回复的自然中文翻译。",
            "- 再另起一行，以「说：」开头给一句用户此刻最可能想说、能推进对话的目标语言短句（纯句子，无引号无解释）。",
          ].join("\n")
        : level === "basic"
          ? [
              "【入门学习者模式】",
              "- 用简短句和常见词汇，避免俚语与复杂从句。",
              "- 正文后另起一行，以「译：」开头给出你整段回复的中文翻译。",
            ].join("\n")
          : null;
    const messages = scaffold ? [...session.history, { role: "system" as const, content: scaffold }] : session.history;

    const result = decision.provider.chat({
      messages,
      temperature: 0.7,
      maxTokens: 300,
    });

    let raw = "";
    for await (const chunk of result.chunks) raw += chunk;
    const usage = await result.usage();
    session.meter.record(decision.provider.model, usage, {
      tags: { sessionId, task: "dialogue" },
    });

    // 剥离「译：」「说：」标记行：正文入历史（语音也只播正文），翻译与建议句单独下发
    const { reply, translation, suggestion } = splitScaffolding(raw);
    session.history.push({ role: "assistant", content: reply });

    await this.repo.save(session);
    const wallet = await this.wallets.getWallet(session.userId);

    return {
      sessionId,
      reply,
      ...(translation ? { translation } : {}),
      ...(suggestion ? { suggestion } : {}),
      chargedCents,
      balanceCredits: wallet.balanceCredits,
    };
  }

  async end(sessionId: string): Promise<EndResult> {
    const session = await this.mustGet(sessionId);
    if (session.status !== "active") throw new ConversationEndedError(sessionId);

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
      billingNote: `按轮计费 · 累计 ${session.totalBilledCents} 厘`,
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

  /** 用户全部会话（学习档案/导出用，按开始时间升序） */
  async listByUser(userId: string): Promise<ConversationSession[]> {
    return this.repo.listByUser(userId);
  }

  private async mustGet(sessionId: string): Promise<ConversationSession> {
    const session = await this.repo.get(sessionId);
    if (!session) throw new ConversationNotFoundError(sessionId);
    return session;
  }
}
