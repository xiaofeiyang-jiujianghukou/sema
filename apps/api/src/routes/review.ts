/**
 * 复盘报告路由
 * POST /v1/conversations/:sessionId/review —— 生成（幂等，一次会话一份）
 * GET  /v1/conversations/:sessionId/review —— 拉取已生成的报告
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

export const reviewRoutes: FastifyPluginAsync = async (app) => {
  app.post("/conversations/:sessionId/review", async (req, reply) => {
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(req.params);
    try {
      const review = await app.reviews.generate(sessionId);
      // 学习闭环：报告里的生词自动入本（幂等，同词去重）
      const vocabIngested = await app.vocabBook.addFromReview(review);
      return { ...review, vocabIngested };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "CONVERSATION_NOT_ENDED") return reply.code(409).send({ error: code, message: (err as Error).message });
      if (code === "REVIEW_PARSE_ERROR") return reply.code(502).send({ error: code, message: (err as Error).message });
      if ((err as Error).message.includes("不存在")) return reply.code(404).send({ error: "SESSION_NOT_FOUND", message: (err as Error).message });
      if ((err as Error).message.includes("余额不足")) return reply.code(402).send({ error: "INSUFFICIENT_FUNDS", message: (err as Error).message });
      throw err;
    }
  });

  app.get("/conversations/:sessionId/review", async (req, reply) => {
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(req.params);
    const review = await app.reviews.getBySession(sessionId);
    if (!review) return reply.code(404).send({ error: "REVIEW_NOT_FOUND" });
    return review;
  });
};
