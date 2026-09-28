/**
 * 学习档案 + 数据导出路由
 * GET /v1/stats/:userId   —— 学习档案（投入/词汇/连续天数/14 天曲线）
 * GET /v1/users/:userId/export —— 全量数据导出（JSON，终身可携）
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

export const statsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/stats/:userId", async (req) => {
    const { userId } = z.object({ userId: z.string().min(1).max(64) }).parse(req.params);
    return app.stats.profile(userId);
  });

  app.get("/users/:userId/export", async (req) => {
    const { userId } = z.object({ userId: z.string().min(1).max(64) }).parse(req.params);
    const [sessions, reviews, vocab] = await Promise.all([
      app.conversations.listByUser(userId),
      app.reviews.listByUser(userId),
      app.vocabBook.list(userId),
    ]);
    // 导出走干净数据面：剥离运行时对象（meter）与内部计费水位线
    return {
      exportedAtMs: Date.now(),
      userId,
      sessions: sessions.map((s) => ({
        id: s.id,
        scenarioId: s.scenarioId,
        status: s.status,
        startedAtMs: s.startedAtMs,
        endedAtMs: s.endedAtMs,
        totalBilledCents: s.totalBilledCents,
        transcript: s.history.filter((m) => m.role !== "system"),
      })),
      reviews: reviews.map((r) => ({ ...r })),
      vocab: vocab.map((c) => ({
        id: c.id,
        term: c.term,
        translation: c.translation,
        context: c.context,
        lecture: c.lecture,
        dueMs: c.dueMs,
        stability: c.stability,
        difficulty: c.difficulty,
        reps: c.reps,
        lapses: c.lapses,
        createdAtMs: c.createdAtMs,
      })),
    };
  });
};
