import type { FastifyPluginAsync } from "fastify";
import { formatCredits, priceOf, type ActionType } from "@yanquan/shared";
import { z } from "zod";
import { InsufficientFundsError } from "../modules/wallet/service.js";

const actionCodes = ["ai_conversation", "review_report", "vocab_lecture", "scenario_pack"] as const;

const chargeSchema = z.object({
  action: z.enum(actionCodes),
  quantity: z.number().positive().max(86_400),
  relatedId: z.string().max(128).optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

const grantSchema = z.object({
  cents: z.number().int().positive().max(1_000_000),
  reason: z.string().min(1).max(200),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

const topupSchema = z.object({
  cents: z.number().int().positive().max(10_000_000),
  relatedId: z.string().max(128).optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

export const walletRoutes: FastifyPluginAsync = async (app) => {
  app.get("/:userId", async (req) => {
    const { userId } = z.object({ userId: z.string().min(1).max(64) }).parse(req.params);
    return app.wallets.getWallet(userId);
  });

  app.post("/:userId/charge", async (req, reply) => {
    const { userId } = z.object({ userId: z.string().min(1).max(64) }).parse(req.params);
    const parsed = chargeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", issues: parsed.error.issues } });
    }
    try {
      const { entry, replayed } = await app.wallets.charge(
        userId,
        parsed.data.action as ActionType,
        parsed.data.quantity,
        {
          relatedId: parsed.data.relatedId,
          idempotencyKey: parsed.data.idempotencyKey,
        },
      );
      const def = priceOf(parsed.data.action as ActionType);
      return {
        amountCents: entry.amountCents,
        balanceAfter: entry.balanceAfter,
        balanceCredits: formatCredits(entry.balanceAfter),
        replayed,
        pricing: { code: def.code, unit: def.unit, centsPerUnit: def.centsPerUnit, displayName: def.displayName },
      };
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        return reply.code(409).send({
          error: {
            code: err.code,
            message: "积分余额不足，请充值",
            neededCents: err.neededCents,
            balanceCents: err.balanceCents,
          },
        });
      }
      throw err;
    }
  });

  // 开发通道：生产环境不注册（充值走支付回调）
  if (process.env.NODE_ENV !== "production") {
    app.post("/:userId/grant", async (req, reply) => {
      const { userId } = z.object({ userId: z.string().min(1).max(64) }).parse(req.params);
      const parsed = grantSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "BAD_REQUEST", issues: parsed.error.issues } });
      }
      const { entry, replayed } = await app.wallets.grant(
        userId,
        parsed.data.cents,
        parsed.data.reason,
        parsed.data.idempotencyKey,
      );
      return reply.code(replayed ? 200 : 201).send({
        entryId: entry.id,
        balanceAfter: entry.balanceAfter,
        balanceCredits: formatCredits(entry.balanceAfter),
        replayed,
      });
    });

    app.post("/:userId/topup", async (req, reply) => {
      const { userId } = z.object({ userId: z.string().min(1).max(64) }).parse(req.params);
      const parsed = topupSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "BAD_REQUEST", issues: parsed.error.issues } });
      }
      const { entry, replayed } = await app.wallets.topup(
        userId,
        parsed.data.cents,
        "充值（开发通道）",
        { relatedId: parsed.data.relatedId, idempotencyKey: parsed.data.idempotencyKey },
      );
      return reply.code(replayed ? 200 : 201).send({
        entryId: entry.id,
        balanceAfter: entry.balanceAfter,
        balanceCredits: formatCredits(entry.balanceAfter),
        replayed,
      });
    });
  }
};
