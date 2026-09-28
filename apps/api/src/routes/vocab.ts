/**
 * 生词本路由
 * GET  /v1/vocab?userId=             —— 全部卡片（按到期排序）
 * GET  /v1/vocab/due?userId=         —— 到期队列
 * POST /v1/vocab                     —— 手动添加 {userId, term, translation, context?}
 * POST /v1/vocab/:cardId/review      —— 打分 {userId, grade: 1..4}
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const gradeSchema = z.object({
  userId: z.string().min(1).max(64),
  grade: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
});

export const vocabRoutes: FastifyPluginAsync = async (app) => {
  app.get("/vocab", async (req) => {
    const { userId } = z.object({ userId: z.string().min(1).max(64) }).parse(req.query);
    const cards = await app.vocabBook.list(userId);
    return { cards, count: cards.length };
  });

  app.get("/vocab/due", async (req) => {
    const { userId } = z.object({ userId: z.string().min(1).max(64) }).parse(req.query);
    const cards = await app.vocabBook.due(userId);
    return { cards, count: cards.length };
  });

  app.post("/vocab", async (req, reply) => {
    const body = z.object({
      userId: z.string().min(1).max(64),
      term: z.string().min(1).max(80),
      translation: z.string().min(1).max(200),
      context: z.string().max(500).optional(),
      sourceSessionId: z.string().uuid().optional(),
    }).parse(req.body);
    const { card, created } = await app.vocabBook.add({
      userId: body.userId,
      term: body.term,
      translation: body.translation,
      ...(body.context !== undefined ? { context: body.context } : {}),
      ...(body.sourceSessionId !== undefined ? { sourceSessionId: body.sourceSessionId } : {}),
    });
    return reply.code(created ? 201 : 200).send({ card, created });
  });

  app.post("/vocab/:cardId/review", async (req, reply) => {
    const { cardId } = z.object({ cardId: z.string().uuid() }).parse(req.params);
    const body = gradeSchema.parse(req.body);
    try {
      const result = await app.vocabBook.grade(body.userId, cardId, body.grade);
      return result;
    } catch (err) {
      if ((err as { code?: string }).code === "VOCAB_CARD_NOT_FOUND") {
        return reply.code(404).send({ error: "VOCAB_CARD_NOT_FOUND", message: (err as Error).message });
      }
      throw err;
    }
  });
};
