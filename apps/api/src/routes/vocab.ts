/**
 * 生词本路由
 * GET  /v1/vocab?userId=             —— 全部卡片（按到期排序）
 * GET  /v1/vocab/due?userId=         —— 到期队列
 * POST /v1/vocab                     —— 手动添加 {userId, term, translation, context?}
 * POST /v1/vocab/:cardId/review      —— 打分 {userId, grade: 1..4}
 * POST /v1/vocab/:cardId/lecture     —— AI 精讲（每词一次，10厘/词，缓存终身）
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "./auth.js";

const gradeSchema = z.object({
  grade: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
});

export const vocabRoutes: FastifyPluginAsync = async (app) => {
  app.get("/vocab", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID" });
    const cards = await app.vocabBook.list(req.userId);
    return { cards, count: cards.length };
  });

  app.get("/vocab/due", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID" });
    const cards = await app.vocabBook.due(req.userId);
    return { cards, count: cards.length };
  });

  app.post("/vocab", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID" });
    const body = z.object({
      term: z.string().min(1).max(80),
      translation: z.string().min(1).max(200),
      context: z.string().max(500).optional(),
      sourceSessionId: z.string().uuid().optional(),
    }).parse(req.body);
    const { card, created } = await app.vocabBook.add({
      userId: req.userId,
      term: body.term,
      translation: body.translation,
      ...(body.context !== undefined ? { context: body.context } : {}),
      ...(body.sourceSessionId !== undefined ? { sourceSessionId: body.sourceSessionId } : {}),
    });
    return reply.code(created ? 201 : 200).send({ card, created });
  });

  app.post("/vocab/:cardId/lecture", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID" });
    const { cardId } = z.object({ cardId: z.string().uuid() }).parse(req.params);
    try {
      return await app.lectures.generate(req.userId, cardId);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "VOCAB_CARD_NOT_FOUND") return reply.code(404).send({ error: code, message: (err as Error).message });
      if (code === "LECTURE_PARSE_ERROR") return reply.code(502).send({ error: code, message: (err as Error).message });
      if ((err as Error).message.includes("余额不足")) return reply.code(402).send({ error: "INSUFFICIENT_FUNDS", message: (err as Error).message });
      throw err;
    }
  });

  app.post("/vocab/:cardId/review", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID" });
    const { cardId } = z.object({ cardId: z.string().uuid() }).parse(req.params);
    const body = gradeSchema.parse(req.body);
    try {
      const result = await app.vocabBook.grade(req.userId, cardId, body.grade);
      return result;
    } catch (err) {
      if ((err as { code?: string }).code === "VOCAB_CARD_NOT_FOUND") {
        return reply.code(404).send({ error: "VOCAB_CARD_NOT_FOUND", message: (err as Error).message });
      }
      throw err;
    }
  });
};
