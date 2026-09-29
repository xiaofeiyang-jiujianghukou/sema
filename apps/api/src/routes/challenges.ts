/**
 * 闯关路由：列表/跟读判定/领取/会话轮数自动判定
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
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

  /** 混合练习题目（选择/判断/完形/造句/连线/跟读，答案不下发） */
  app.get("/:id/exercises", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID" });
    try {
      return { exercises: app.challenges.exercises((req.params as { id: string }).id) };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "出题失败" });
    }
  });

  /** 混合练习判题 */
  app.post("/:id/check", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID" });
    const parsed = z.object({ index: z.number().int().min(0).max(49), answer: z.unknown() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "BAD_REQUEST" });
    try {
      return app.challenges.check((req.params as { id: string }).id, parsed.data.index, parsed.data.answer);
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
      const { index, left, right } = parsed.data;
      return app.challenges.pair((req.params as { id: string }).id, index, left, right);
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
    const parsed = z.object({ matched: z.number().int().min(0).max(10) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "BAD_REQUEST" });
    try {
      const res = await app.challenges.claimBeginner(req.userId, (req.params as { id: string }).id, parsed.data.matched, CHALLENGES);
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
