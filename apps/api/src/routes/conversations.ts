import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { listScenarioSummaries } from "../content/scenarios.js";
import {
  ConversationEndedError,
  ConversationNotFoundError,
} from "../modules/conversation/service.js";
import { ScenarioNotFoundError } from "../modules/conversation/service.js";
import { requireAuth } from "./auth.js";
import { InsufficientFundsError } from "../modules/wallet/service.js";

const startSchema = z.object({
  scenarioId: z.string().min(1).max(64),
});

const turnSchema = z.object({
  text: z.string().trim().min(1).max(2000),
});

export const conversationRoutes: FastifyPluginAsync = async (app) => {
  // 情景目录（静态路由优先于 :id 匹配）；可按目标语言过滤
  app.get("/scenarios", async (req, reply) => {
    const queryCheck = z.object({ targetLang: z.enum(["en", "ja", "ko"]).optional() }).safeParse(req.query);
    if (!queryCheck.success) return reply.code(400).send({ error: { code: "BAD_REQUEST", issues: queryCheck.error.issues } });
    return { scenarios: listScenarioSummaries(queryCheck.data.targetLang) };
  });

  app.post("/", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID", message: "未登录" });
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", issues: parsed.error.issues } });
    }
    try {
      const result = await app.conversations.start(req.userId, parsed.data.scenarioId);
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof ScenarioNotFoundError) {
        return reply.code(404).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  app.post("/:sessionId/turns", async (req, reply) => {
    const { sessionId } = z
      .object({ sessionId: z.string().min(1).max(64) })
      .parse(req.params);
    const parsed = turnSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", issues: parsed.error.issues } });
    }
    try {
      return await app.conversations.turn(sessionId, parsed.data.text);
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        return reply.code(409).send({
          error: {
            code: err.code,
            message: "积分余额不足，对话已暂停，充值后继续",
            neededCents: err.neededCents,
            balanceCents: err.balanceCents,
          },
        });
      }
      if (
        err instanceof ConversationEndedError ||
        err instanceof ConversationNotFoundError
      ) {
        return reply.code(err instanceof ConversationEndedError ? 409 : 404).send({
          error: { code: err.code, message: err.message },
        });
      }
      throw err;
    }
  });

  app.post("/:sessionId/end", async (req, reply) => {
    const { sessionId } = z
      .object({ sessionId: z.string().min(1).max(64) })
      .parse(req.params);
    try {
      return await app.conversations.end(sessionId);
    } catch (err) {
      if (err instanceof ConversationNotFoundError) {
        return reply.code(404).send({ error: { code: err.code, message: err.message } });
      }
      if (err instanceof ConversationEndedError) {
        return reply.code(409).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  app.get("/:sessionId", async (req, reply) => {
    const { sessionId } = z
      .object({ sessionId: z.string().min(1).max(64) })
      .parse(req.params);
    try {
      return await app.conversations.snapshot(sessionId);
    } catch (err) {
      if (err instanceof ConversationNotFoundError) {
        return reply.code(404).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });
};
