/**
 * 身份认证——账号体系的地基
 *
 * 设计要点：
 * - 密码：node:crypto scrypt（自带 salt，无原生依赖），timingSafeEqual 比对
 * - 验证码：6 位数字、5 分钟有效、一次性消费；按手机号限流（60s 冷却 + 每小时 5 条）
 * - 会话：不透明随机令牌（32B hex，30 天），服务端可撤销——比 JWT 简单且可踢下线
 * - 短信：SmsSender 接口抽象。dev/测试用 FixedCodeSmsSender；
 *   生产接阿里云/腾讯云短信（用户提供凭证后实现 AliyunSmsSender 即可）
 * - 手机号：当前按中国大陆 11 位校验（产品首发市场；其他国家格式后续加）
 */
import { randomBytes, randomInt, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import type { TargetLang } from "../../content/scenarios.js";

export const PHONE_RE = /^1[3-9]\d{9}$/;
const CODE_TTL_MS = 5 * 60 * 1000;
const CODE_COOLDOWN_MS = 60 * 1000;
const CODE_HOURLY_LIMIT = 5;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface UserAccount {
  id: string;
  phone: string;
  nickname: string;
  /** 目标语言偏好（注册后可在设置里改；情景选择独立于此） */
  targetLang: TargetLang;
  passwordHash: string | null; // null = 仅验证码登录（未设密码）
  passwordSalt: string | null;
  createdAtMs: number;
}

export interface UserRepo {
  create(user: UserAccount): Promise<void>;
  get(id: string): Promise<UserAccount | null>;
  findByPhone(phone: string): Promise<UserAccount | null>;
  save(user: UserAccount): Promise<void>;
  /** 注销账号：删除用户记录 */
  delete(id: string): Promise<void>;
}

/** 注销账号时级联删除的数据源 */
export interface AccountDeletionRepos {
  conversationRepo: { deleteByUser(userId: string): Promise<number> };
  reviewRepo: { deleteByUser(userId: string): Promise<number> };
  vocabRepo: { deleteByUser(userId: string): Promise<number> };
  walletRepo: { deleteByUser(userId: string): Promise<{ walletDeleted: boolean; ledgerAnonymized: number }> };
  userRepo: UserRepo;
}

export class MemoryUserRepo implements UserRepo {
  private readonly users = new Map<string, UserAccount>();

  async create(user: UserAccount): Promise<void> {
    for (const existing of this.users.values()) {
      if (existing.phone === user.phone) throw new Error("该手机号已注册");
    }
    this.users.set(user.id, user);
  }

  async get(id: string): Promise<UserAccount | null> {
    return this.users.get(id) ?? null;
  }

  async delete(id: string): Promise<void> {
    this.users.delete(id);
  }

  async findByPhone(phone: string): Promise<UserAccount | null> {
    for (const user of this.users.values()) {
      if (user.phone === phone) return user;
    }
    return null;
  }

  async save(user: UserAccount): Promise<void> {
    this.users.set(user.id, user);
  }
}

/** 短信发送抽象——生产环境实现类接云服务商 SDK */
export interface SmsSender {
  send(phone: string, code: string, purpose: "register" | "login"): Promise<void>;
}

/** 开发/测试：固定验证码（不入生产；生产用云短信实现类替换） */
export class FixedCodeSmsSender implements SmsSender {
  constructor(private readonly code: string) {}
  async send(): Promise<void> {}
  peekCode(): string {
    return this.code;
  }
}

/** 控制台短信：把验证码打进服务端日志（独立自测用） */
export class ConsoleSmsSender implements SmsSender {
  async send(phone: string, code: string, purpose: "register" | "login"): Promise<void> {
    console.log(`[sms:${purpose}] ${phone} 验证码 ${code}（5 分钟内有效）`);
  }
}

interface PendingCode {
  codeHash: string;
  purpose: "register" | "login";
  expiresAtMs: number;
  used: boolean;
}

export class AuthError extends Error {
  constructor(readonly code: "PHONE_INVALID" | "CODE_EXPIRED" | "CODE_WRONG" | "CODE_COOLDOWN" | "CODE_LIMIT" | "PHONE_TAKEN" | "USER_NOT_FOUND" | "PASSWORD_NOT_SET" | "PASSWORD_WRONG" | "PASSWORD_WEAK" | "TOKEN_INVALID") {
    super(code);
  }
}

export interface AuthDeps {
  users: UserRepo;
  sms: SmsSender;
  now: () => number;
  /** 验证码生成器（测试注入固定值；缺省随机 6 位） */
  codeFactory?: () => string;
}

export interface SessionInfo {
  token: string;
  user: PublicUser;
  expiresAtMs: number;
}

/** 用户公开信息（绝不含密码字段） */
export interface PublicUser {
  id: string;
  phone: string;
  nickname: string;
  targetLang: TargetLang;
  createdAtMs: number;
}

function toPublic(user: UserAccount): PublicUser {
  return { id: user.id, phone: user.phone, nickname: user.nickname, targetLang: user.targetLang, createdAtMs: user.createdAtMs };
}

export class AuthService {
  /** token → userId（鉴权中间件查询用） */
  private readonly sessions = new Map<string, { userId: string; expiresAtMs: number }>();
  private readonly codes = new Map<string, { pending: PendingCode; sentAtMs: number; hourly: number[] }>();

  constructor(private readonly deps: AuthDeps) {}

  private codeHash(phone: string, code: string): string {
    return createHash("sha256").update(`${phone}:${code}`).digest("hex");
  }

  /** 发送验证码（限流：60s 冷却 + 每小时 5 条） */
  async requestCode(phone: string, purpose: "register" | "login"): Promise<{ cooldownMs: number }> {
    if (!PHONE_RE.test(phone)) throw new AuthError("PHONE_INVALID");
    const now = this.deps.now();
    const state = this.codes.get(phone);
    if (state) {
      if (now - state.sentAtMs < CODE_COOLDOWN_MS) {
        throw new AuthError("CODE_COOLDOWN");
      }
      state.hourly = state.hourly.filter((t) => now - t < 60 * 60 * 1000);
      if (state.hourly.length >= CODE_HOURLY_LIMIT) throw new AuthError("CODE_LIMIT");
    }
    if (purpose === "register") {
      const existing = await this.deps.users.findByPhone(phone);
      if (existing) throw new AuthError("PHONE_TAKEN");
    }

    const code = this.deps.codeFactory?.() ?? String(randomInt(0, 1_000_000)).padStart(6, "0");
    await this.deps.sms.send(phone, code, purpose);
    this.codes.set(phone, {
      pending: { codeHash: this.codeHash(phone, code), purpose, expiresAtMs: now + CODE_TTL_MS, used: false },
      sentAtMs: now,
      hourly: [...(state?.hourly ?? []), now],
    });
    return { cooldownMs: CODE_COOLDOWN_MS };
  }

  private consumeCode(phone: string, code: string, purpose: "register" | "login"): void {
    const state = this.codes.get(phone);
    const now = this.deps.now();
    if (!state || state.pending.used || state.pending.purpose !== purpose) throw new AuthError("CODE_WRONG");
    if (now > state.pending.expiresAtMs) throw new AuthError("CODE_EXPIRED");
    const given = Buffer.from(this.codeHash(phone, code));
    const stored = Buffer.from(state.pending.codeHash);
    if (given.length !== stored.length || !timingSafeEqual(given, stored)) throw new AuthError("CODE_WRONG");
    state.pending.used = true; // 一次性
  }

  private newSession(userId: string): { token: string; expiresAtMs: number } {
    const token = randomBytes(32).toString("hex");
    const expiresAtMs = this.deps.now() + SESSION_TTL_MS;
    this.sessions.set(token, { userId, expiresAtMs });
    return { token, expiresAtMs };
  }

  async register(input: { phone: string; code: string; password?: string; nickname?: string }): Promise<SessionInfo> {
    this.consumeCode(input.phone, input.code, "register");
    const password = input.password ?? "";
    if (password.length < 8 || password.length > 64) throw new AuthError("PASSWORD_WEAK");

    const salt = randomBytes(16).toString("hex");
    const user: UserAccount = {
      id: `u_${randomBytes(8).toString("hex")}`,
      phone: input.phone,
      nickname: input.nickname?.trim() || `同学${input.phone.slice(-4)}`,
      targetLang: "en",
      passwordHash: scryptSync(password, salt, 64).toString("hex"),
      passwordSalt: salt,
      createdAtMs: this.deps.now(),
    };
    await this.deps.users.create(user);
    const session = this.newSession(user.id);
    return { ...session, user: toPublic(user) };
  }

  async loginPassword(phone: string, password: string): Promise<SessionInfo> {
    const user = await this.deps.users.findByPhone(phone);
    if (!user) throw new AuthError("USER_NOT_FOUND");
    if (!user.passwordHash || !user.passwordSalt) throw new AuthError("PASSWORD_NOT_SET");
    const given = scryptSync(password, user.passwordSalt, 64);
    const stored = Buffer.from(user.passwordHash, "hex");
    if (given.length !== stored.length || !timingSafeEqual(given, stored)) throw new AuthError("PASSWORD_WRONG");
    const session = this.newSession(user.id);
    return { ...session, user: toPublic(user) };
  }

  async loginCode(phone: string, code: string): Promise<SessionInfo> {
    const user = await this.deps.users.findByPhone(phone);
    if (!user) throw new AuthError("USER_NOT_FOUND");
    this.consumeCode(phone, code, "login");
    const session = this.newSession(user.id);
    return { ...session, user: toPublic(user) };
  }

  async me(token: string): Promise<PublicUser> {
    const userId = this.userIdOf(token);
    const user = await this.deps.users.get(userId);
    if (!user) throw new AuthError("TOKEN_INVALID");
    return toPublic(user);
  }

  async updateMe(token: string, patch: { nickname?: string; targetLang?: TargetLang }): Promise<PublicUser> {
    const userId = this.userIdOf(token);
    const user = await this.deps.users.get(userId);
    if (!user) throw new AuthError("TOKEN_INVALID");
    if (patch.nickname !== undefined) user.nickname = patch.nickname.trim().slice(0, 24) || user.nickname;
    if (patch.targetLang !== undefined) user.targetLang = patch.targetLang;
    await this.deps.users.save(user);
    return toPublic(user);
  }

  async logout(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  /** 鉴权中间件用：令牌 → userId（过期即无效） */
  /** 注销账号：撤销该用户全部会话令牌 */
  revokeAllForUser(userId: string): number {
    let n = 0;
    for (const [token, session] of this.sessions) {
      if (session.userId === userId) {
        this.sessions.delete(token);
        n += 1;
      }
    }
    return n;
  }

  userIdOf(token: string): string {
    const session = this.sessions.get(token);
    if (!session || this.deps.now() > session.expiresAtMs) {
      this.sessions.delete(token);
      throw new AuthError("TOKEN_INVALID");
    }
    return session.userId;
  }
}
