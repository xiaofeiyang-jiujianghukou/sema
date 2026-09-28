/**
 * 复盘报告——学习闭环的第一环
 *
 * 会话结束后，把完整转写交给旗舰模型做一次结构化复盘：
 * 纠错（语法/选词/地道度）、更地道说法、生词提取（喂给生词本）。
 * 一次会话只计费一次（幂等键 review:sessionId），重新生成不再扣费。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PRICING } from "@sema/shared";
import { getScenario, type TargetLang } from "../../content/scenarios.js";
import type { ConversationRepo } from "../conversation/repo.js";
import type { WalletService } from "../wallet/service.js";
import type { TaskRouter } from "@sema/ai-core";

export class ConversationNotEndedError extends Error {
  readonly code = "CONVERSATION_NOT_ENDED";
  constructor(readonly sessionId: string) {
    super(`会话尚未结束，无法复盘: ${sessionId}`);
  }
}

export class ReviewParseError extends Error {
  readonly code = "REVIEW_PARSE_ERROR";
  constructor(detail: string) {
    super(`复盘输出解析失败: ${detail}`);
  }
}

const reviewPayloadSchema = z.object({
  corrections: z.array(z.object({
    original: z.string().min(1),
    corrected: z.string().min(1),
    explanation: z.string().min(1),
    kind: z.enum(["grammar", "word-choice", "naturalness"]).default("naturalness"),
  })).max(20),
  alternatives: z.array(z.object({
    original: z.string().min(1),
    suggestion: z.string().min(1),
    note: z.string().min(1),
  })).max(20),
  vocab: z.array(z.object({
    term: z.string().min(1).max(80),
    translation: z.string().min(1).max(200),
    contextSentence: z.string().min(1).max(500),
  })).max(20),
  overall: z.object({
    level: z.string().min(1).max(40),
    strengths: z.string().min(1),
    focus: z.string().min(1),
  }),
});

export type ReviewPayload = z.infer<typeof reviewPayloadSchema>;

export interface SessionReview extends ReviewPayload {
  id: string;
  sessionId: string;
  userId: string;
  scenarioId: string;
  createdAtMs: number;
  /** 本次复盘计费（厘） */
  priceCents: number;
}

export interface ReviewRepo {
  save(review: SessionReview): Promise<void>;
  getBySession(sessionId: string): Promise<SessionReview | null>;
  listByUser(userId: string): Promise<SessionReview[]>;
}

export class MemoryReviewRepo implements ReviewRepo {
  private readonly byId = new Map<string, SessionReview>();
  private readonly bySession = new Map<string, string>();

  async save(review: SessionReview): Promise<void> {
    this.byId.set(review.id, review);
    this.bySession.set(review.sessionId, review.id);
  }

  async getBySession(sessionId: string): Promise<SessionReview | null> {
    const id = this.bySession.get(sessionId);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async listByUser(userId: string): Promise<SessionReview[]> {
    return [...this.byId.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
  }
}

const LANG_LABEL: Record<TargetLang, string> = {
  en: "English",
  ja: "Japanese",
  ko: "Korean",
};

function reviewPrompt(target: TargetLang): string {
  return `You are an expert ${LANG_LABEL[target]} coach reviewing a Chinese learner's spoken ${LANG_LABEL[target]} conversation.
Analyze the transcript and reply with ONLY a JSON object (no markdown, no code fence) matching:
{
  "corrections": [{"original": "learner's flawed sentence", "corrected": "fixed sentence in natural ${LANG_LABEL[target]}", "explanation": "中文解释为什么", "kind": "grammar|word-choice|naturalness"}],
  "alternatives": [{"original": "learner's OK sentence", "suggestion": "more idiomatic ${LANG_LABEL[target]} version", "note": "中文说明为什么更地道"}],
  "vocab": [{"term": "useful word/phrase from context", "translation": "中文释义", "contextSentence": "the sentence where it appeared"}],
  "overall": {"level": "CEFR-ish level estimate (A1-C1)", "strengths": "中文，做得好的地方", "focus": "中文，下一步最该练什么"}
}
Rules: reply in ${LANG_LABEL[target]} for all learning content (corrected/suggestion/term/contextSentence); explanations stay in Chinese. corrections max 6 (only real errors — if the learner made no mistakes, return an empty array instead of inventing errors), alternatives max 4, vocab max 8 (useful & appears in transcript), be specific not generic.`;
}

export interface ReviewDeps {
  conversations: ConversationRepo;
  wallets: WalletService;
  router: TaskRouter;
  now: () => number;
}

export class ReviewService {
  constructor(
    private readonly reviews: ReviewRepo,
    private readonly deps: ReviewDeps,
  ) {}

  async generate(sessionId: string): Promise<SessionReview> {
    const existing = await this.reviews.getBySession(sessionId);
    if (existing) return existing; // 幂等：一次会话一份报告，重新拉取不重复计费

    const session = await this.deps.conversations.get(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    if (session.status !== "ended") throw new ConversationNotEndedError(sessionId);

    const transcript = session.history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role === "user" ? "Learner" : "Coach"}: ${m.content}`)
      .join("\n");

    const targetLang = getScenario(session.scenarioId)?.targetLang ?? "en";
    const decision = this.deps.router.route("review");
    const result = decision.provider.chat({
      messages: [
        { role: "system", content: reviewPrompt(targetLang) },
        { role: "user", content: transcript },
      ],
      temperature: 0.2,
      maxTokens: 2000,
    });
    let raw = "";
    for await (const chunk of result.chunks) raw += chunk;

    const payload = this.parsePayload(raw);
    session.meter.record(decision.provider.model, await result.usage(), {
      tags: { sessionId, task: "review" },
    });

    const priceCents = PRICING.review_report.centsPerUnit;
    await this.deps.wallets.charge(session.userId, "review_report", 1, {
      idempotencyKey: `review:${sessionId}`,
      reason: `对话复盘报告 ${sessionId.slice(0, 8)}`,
    });

    const review: SessionReview = {
      id: randomUUID(),
      sessionId,
      userId: session.userId,
      scenarioId: session.scenarioId,
      createdAtMs: this.deps.now(),
      priceCents,
      ...payload,
    };
    await this.reviews.save(review);
    return review;
  }

  async getBySession(sessionId: string): Promise<SessionReview | null> {
    return this.reviews.getBySession(sessionId);
  }

  async listByUser(userId: string): Promise<SessionReview[]> {
    return this.reviews.listByUser(userId);
  }

  private parsePayload(raw: string): ReviewPayload {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new ReviewParseError("响应中找不到 JSON 对象");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch (err) {
      throw new ReviewParseError(`JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    const checked = reviewPayloadSchema.safeParse(parsed);
    if (!checked.success) {
      throw new ReviewParseError(checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    return checked.data;
  }
}
