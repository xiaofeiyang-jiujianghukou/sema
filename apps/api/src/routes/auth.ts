/**
 * 认证路由
 * POST /v1/auth/request-code  发送短信验证码（register/login 两用途，限流）
 * POST /v1/auth/register      手机号 + 验证码 + 密码 注册
 * POST /v1/auth/login         密码登录 或 验证码登录
 * GET  /v1/auth/me            当前用户（Bearer token）
 * PATCH /v1/auth/me           改昵称/目标语言
 * POST /v1/auth/logout        注销令牌（服务端撤销）
 *
 * 鉴权方式：Authorization: Bearer <token>，路由内经 requireAuth 注入 req.userId。
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { AuthError } from "../modules/auth/service.js";

const phoneSchema = z.object({ phone: z.string().regex(/^1[3-9]\d{9}$/, "手机号格式不正确") });

export function authErrorReply(reply: FastifyReply, err: unknown): FastifyReply | undefined {
  if (err instanceof AuthError) {
    const status = err.code === "TOKEN_INVALID" ? 401
      : err.code === "CODE_COOLDOWN" || err.code === "CODE_LIMIT" ? 429
      : err.code === "PHONE_TAKEN" ? 409
      : 400;
    return reply.code(status).send({ error: err.code, message: authMessage(err.code) });
  }
  return undefined;
}

function authMessage(code: string): string {
  const map: Record<string, string> = {
    PHONE_INVALID: "手机号格式不正确",
    CODE_EXPIRED: "验证码已过期，请重新获取",
    CODE_WRONG: "验证码不正确",
    CODE_COOLDOWN: "发送太频繁，请稍后再试",
    CODE_LIMIT: "验证码发送次数已达上限，请一小时后再试",
    PHONE_TAKEN: "该手机号已注册，请直接登录",
    USER_NOT_FOUND: "账号不存在，请先注册",
    PASSWORD_NOT_SET: "该账号未设置密码，请使用验证码登录",
    PASSWORD_WRONG: "手机号或密码不正确",
    PASSWORD_WEAK: "密码长度需在 8-64 位之间",
    TOKEN_INVALID: "登录已失效，请重新登录",
  };
  return map[code] ?? code;
}

/** 业务路由鉴权钩子：校验 Bearer 令牌并注入 req.userId */
export async function requireAuth(app: { auth: { userIdOf(token: string): string } }, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    await reply.code(401).send({ error: "TOKEN_INVALID", message: "未登录" });
    return;
  }
  try {
    req.userId = app.auth.userIdOf(token);
  } catch {
    await reply.code(401).send({ error: "TOKEN_INVALID", message: "登录已失效，请重新登录" });
  }
}

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

const credentialsSchema = z.union([
  z.object({ phone: z.string(), password: z.string().min(1).max(64) }),
  z.object({ phone: z.string(), code: z.string().regex(/^\d{6}$/) }),
]);

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/request-code", async (req, reply) => {
    const parsed = phoneSchema.extend({ purpose: z.enum(["register", "login"]) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "BAD_REQUEST", message: "手机号格式不正确" });
    try {
      return await app.auth.requestCode(parsed.data.phone, parsed.data.purpose);
    } catch (err) {
      return authErrorReply(reply, err) ?? reply.code(500).send({ error: "INTERNAL" });
    }
  });

  app.post("/register", async (req, reply) => {
    const parsed = z.object({
      phone: z.string(),
      code: z.string().regex(/^\d{6}$/),
      password: z.string().min(8).max(64),
      nickname: z.string().max(24).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "BAD_REQUEST", message: "注册信息不完整（密码 8-64 位）" });
    try {
      return reply.code(201).send(await app.auth.register({
        phone: parsed.data.phone,
        code: parsed.data.code,
        password: parsed.data.password,
        ...(parsed.data.nickname !== undefined ? { nickname: parsed.data.nickname } : {}),
      }));
    } catch (err) {
      return authErrorReply(reply, err) ?? reply.code(500).send({ error: "INTERNAL" });
    }
  });

  app.post("/login", async (req, reply) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "BAD_REQUEST", message: "请提供密码或 6 位验证码" });
    try {
      if ("password" in parsed.data) return await app.auth.loginPassword(parsed.data.phone, parsed.data.password);
      return await app.auth.loginCode(parsed.data.phone, parsed.data.code);
    } catch (err) {
      return authErrorReply(reply, err) ?? reply.code(500).send({ error: "INTERNAL" });
    }
  });

  app.get("/me", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID" });
    return app.auth.me(bearerOf(req));
  });

  app.patch("/me", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "TOKEN_INVALID" });
    const parsed = z.object({
      nickname: z.string().min(1).max(24).optional(),
      targetLang: z.enum(["en", "ja", "ko"]).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "BAD_REQUEST" });
    return app.auth.updateMe(bearerOf(req), {
      ...(parsed.data.nickname !== undefined ? { nickname: parsed.data.nickname } : {}),
      ...(parsed.data.targetLang !== undefined ? { targetLang: parsed.data.targetLang } : {}),
    });
  });

  app.post("/logout", async (req, reply) => {
    await app.auth.logout(bearerOf(req));
    return { ok: true };
  });

  // 注销账号：级联删除会话/复盘/生词/钱包；账本去标识留存（财务记录不关联个人）。
  // 语音/音频数据后端从不落盘（流式处理即弃），无可删项。
  app.delete("/me", { preHandler: (req, reply) => requireAuth(app, req, reply) }, async (req) => {
    const userId = req.userId as string;
    const wallet = await app.accountDeletion.walletRepo.deleteByUser(userId);
    const sessions = await app.accountDeletion.conversationRepo.deleteByUser(userId);
    const reviews = await app.accountDeletion.reviewRepo.deleteByUser(userId);
    const cards = await app.accountDeletion.vocabRepo.deleteByUser(userId);
    await app.accountDeletion.userRepo.delete(userId);
    const revokedTokens = app.auth.revokeAllForUser(userId);
    return {
      ok: true,
      deleted: {
        conversations: sessions,
        reviews,
        vocabCards: cards,
        walletDeleted: wallet.walletDeleted,
        ledgerAnonymized: wallet.ledgerAnonymized,
        revokedTokens,
      },
    };
  });
};

function bearerOf(req: FastifyRequest): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}
