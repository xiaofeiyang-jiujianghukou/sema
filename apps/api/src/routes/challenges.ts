/**
 * 闯关路由：列表/跟读判定/领取/会话轮数自动判定
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { levelFor } from "../modules/auth/service.js";
import { getUnit } from "../content/challenges.js";
import { CHALLENGES, challengesForLang } from "../content/challenges.js";
import type { ChallengeService } from "../modules/challenges/service.js";

declare module "fastify" {
  interface FastifyInstance {
    challenges: ChallengeService;
  }
}
import { requireAuth } from "./auth.js";

const langSchema = z.enum(["en", "ja", "ko"]);

export async function challengeRoutes(app: FastifyInstance): Promise<void> {
  /** 关卡列表（含状态） */
  app.get("/", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID" });
    const parsed = langSchema.safeParse((req.query as { lang?: string }).lang);
    if (!parsed.success) return reply.code(400).send({ error: "BAD_REQUEST" });
    const lang = parsed.data;
    const challenges = await app.challenges.list(req.userId, lang, challengesForLang(lang));
    return { lang, challenges };
  });

  /** 初级跟读：整段音频（AAC base64）→ ASR 匹配 */
  app.post("/:id/voice", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID" });
    const parsed = z.object({ audioBase64: z.string().min(64).max(2_000_000) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "BAD_REQUEST" });
    try {
      return await app.challenges.verifyVoice(req.userId, (req.params as { id: string }).id, parsed.data.audioBase64, CHALLENGES);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "判定失败" });
    }
  });

  // 用户水平 → 出题难度（零基础 4 选项/7 过关，入门 5/8，进阶 6/9 且干扰项来自全书）
  const LEVEL_THRESHOLD: Record<string, number> = { zero: 7, basic: 8, pro: 9 };
  const levelOf = async (userId: string, challengeId: string): Promise<{ level: "zero" | "basic" | "pro"; threshold: number }> => {
    const lang = challengeId.startsWith("ja-") ? "ja" : challengeId.startsWith("ko-") ? "ko" : "en";
    const u = await app.users.get(userId);
    const level = u ? levelFor(u, lang) ?? "zero" : "zero";
    return { level, threshold: LEVEL_THRESHOLD[level] ?? 7 };
  };

  /** 混合练习题目（选择/判断/完形/造句/连线/跟读/听音辨词，答案不下发） */
  app.get("/:id/exercises", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID" });
    try {
      const { level, threshold } = await levelOf(req.userId, (req.params as { id: string }).id);
      return { exercises: app.challenges.exercises((req.params as { id: string }).id, level), threshold };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "出题失败" });
    }
  });

  /** 听音辨词音频：TTS 合成单元词（按语言选音色，内存缓存） */
  const audioCache = new Map<string, string>();
  app.post("/:id/audio", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID" });
    const parsed = z.object({ index: z.number().int().min(0).max(49), sentence: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "BAD_REQUEST" });
    try {
      const id = (req.params as { id: string }).id;
      const sentence = parsed.data.sentence === true;
      const cacheKey = `${id}:${parsed.data.index}:${sentence ? 1 : 0}`;
      const cached = audioCache.get(cacheKey);
      if (cached) return { audioBase64: cached };
      const c = CHALLENGES.find((x) => x.id === id);
      const word = c?.words?.[parsed.data.index];
      if (!c || !word) return reply.code(400).send({ error: "词不存在" });
      // 整句读例句（听句选词题）；单词读词（听音辨词题）
      const unit = getUnit(id.replace(/-(words|dialogue)$/, ""));
      const text = sentence ? unit?.words[parsed.data.index]?.example ?? word.text : word.text;
      const speech = app.speechForLang(c.lang);
      let buf = Buffer.alloc(0);
      for await (const chunk of app.speech.tts.synthesize(text, { format: "mp3", ...(speech.speaker ? { speaker: speech.speaker } : {}) })) {
        buf = Buffer.concat([buf, chunk]);
      }
      const audioBase64 = buf.toString("base64");
      audioCache.set(cacheKey, audioBase64);
      return { audioBase64 };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : "合成失败" });
    }
  });

  /** 混合练习判题 */
  app.post("/:id/check", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID" });
    const parsed = z.object({ index: z.number().int().min(0).max(49), answer: z.unknown() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "BAD_REQUEST" });
    try {
      const id = (req.params as { id: string }).id;
      const { level } = await levelOf(req.userId, id);
      return app.challenges.check(id, parsed.data.index, parsed.data.answer, level);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "判题失败" });
    }
  });

  /** 连线逐对判定（对→锁定；错→❗重选） */
  app.post("/:id/check-pair", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID" });
    const parsed = z.object({
      index: z.number().int().min(0).max(49),
      left: z.number().int().min(0).max(9),
      right: z.number().int().min(0).max(9),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "BAD_REQUEST" });
    try {
      const id = (req.params as { id: string }).id;
      const { index, left, right } = parsed.data;
      const { level } = await levelOf(req.userId, id);
      return app.challenges.pair(id, index, left, right, level);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "判定失败" });
    }
  });

  /** 单词判定：一次一个词（游戏化即时反馈） */
  app.post("/:id/word", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID" });
    const parsed = z.object({
      audioBase64: z.string().min(64).max(2_000_000),
      index: z.number().int().min(0).max(49),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "BAD_REQUEST" });
    try {
      return await app.challenges.verifyWord(req.userId, (req.params as { id: string }).id, parsed.data.index, parsed.data.audioBase64);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "判定失败" });
    }
  });

  /** 初级过关领取（matched ≥ 门槛后） */
  app.post("/:id/claim", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID" });
    const parsed = z.object({ matched: z.number().int().min(0).max(30), firstTry: z.number().int().min(0).max(30).optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "BAD_REQUEST" });
    try {
      const id = (req.params as { id: string }).id;
      const { threshold, level } = await levelOf(req.userId, id);
      // total = 本关题目总数（服务端权威），星级与奖励缩放都在服务端算
      const total = app.challenges.exercises(id, level).length;
      const res = await app.challenges.claimBeginner(req.userId, id, parsed.data.matched, CHALLENGES, threshold, parsed.data.firstTry, total);
      const wallet = await app.wallets.getWallet(req.userId);
      return { ...res, balanceCredits: wallet.balanceCredits };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "领取失败" });
    }
  });

  /** 中级/高级：对话结束后用会话轮数自动判定该语言所有对话型挑战 */
  app.post("/session-attempt", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID" });
    const parsed = z.object({ sessionId: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "BAD_REQUEST" });
    return app.challenges.attemptSession(req.userId, parsed.data.sessionId, CHALLENGES);
  });
}
