/**
 * 说嘛 API 客户端
 *
 * API 地址：
 * - Android 模拟器默认 http://10.0.2.2:8787（宿主机回环）
 * - 真机（Expo Go）：启动时注入 EXPO_PUBLIC_API_URL=http://<电脑局域网IP>:8787
 */
import * as SecureStore from "expo-secure-store";

export const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:8787";
const TOKEN_KEY = "sema.session.token";

export interface PublicUser {
  id: string;
  phone: string;
  nickname: string;
  targetLang: "en" | "ja" | "ko";
  /** 学习者水平：决定对话难度与中文辅助（零基础=译+建议句） */
  level?: "zero" | "basic" | "pro" | undefined;
  createdAtMs: number;
}

export interface ScenarioSummary {
  id: string;
  targetLang: "en" | "ja" | "ko";
  title: string;
  titleEn: string;
  emoji: string;
  difficulty: string;
  setting: string;
}

export interface WordLookup {
  word: string;
  translation: string;
  pos: string | null;
  note: string | null;
  fromBook: boolean;
  chargedCents: number;
  balanceCredits: string;
}

export interface MessageTranslation {
  translation: string;
  chargedCents: number;
  balanceCredits: string;
}

export interface StartResult {
  sessionId: string;
  scenario: ScenarioSummary & { goals: string[] };
  opener: string;
  pricing: { centsPerSecond: number };
}

export interface TurnResult {
  reply: string;
  /** 零基础/入门模式：AI 回复的中文翻译 */
  translation?: string;
  /** 零基础模式：建议用户此刻说的一句目标语言 */
  suggestion?: string;
  chargedCents: number;
  balanceCredits: string;
}

export interface EndResult {
  sessionId: string;
  durationSeconds: number;
  turns: number;
  totalBilledCents: number;
  balanceCredits: string;
  billingNote: string;
}

export interface ReviewReport {
  sessionId: string;
  corrections: Array<{ original: string; corrected: string; explanation: string; kind: string }>;
  alternatives: Array<{ original: string; suggestion: string; note: string }>;
  vocab: Array<{ term: string; translation: string; contextSentence: string }>;
  overall: { level: string; strengths: string; focus: string };
  vocabIngested?: { added: number; duplicates: number };
  priceCents: number;
}

export interface VocabCard {
  id: string;
  term: string;
  translation: string;
  context: string | null;
  dueMs: number;
  reps: number;
  reviewCount: number;
  lecture: VocabLecture | null;
}

export interface VocabLecture {
  definition: string;
  examples: Array<{ text: string; zh: string }>;
  nuance: string;
  memoryHook: string;
  collocations: string[];
}

export interface LearningProfile {
  sessions: number;
  totalSeconds: number;
  turns: number;
  totalBilledCents: number;
  vocab: { total: number; dueNow: number; addedLast7Days: number; reviewsDone: number };
  streakDays: number;
  activity: Array<{ date: string; seconds: number; turns: number }>;
}

export interface WalletInfo {
  balanceCents: number;
  balanceCredits: string;
  entries: Array<{ id: string; amountCents: number; reason: string | null; createdAtMs: number }>;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { token?: string | null } = {}): Promise<T> {
  const headers: Record<string, string> = init.body ? { "Content-Type": "application/json" } : {};
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof body.error === "string" ? body.error : ((body.error as { code?: string } | undefined)?.code ?? "ERROR");
    const message = typeof body.message === "string" ? body.message : (body.error as string) ?? `请求失败（${res.status}）`;
    throw new ApiError(res.status, code, message);
  }
  return body as T;
}

/* ── 会话令牌存取（SecureStore：Android Keystore 加密存储） ── */

export async function loadToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

/* ── 认证 ── */

export const auth = {
  requestCode: (phone: string, purpose: "register" | "login") =>
    request<{ cooldownMs: number }>("/v1/auth/request-code", { method: "POST", body: JSON.stringify({ phone, purpose }) }),
  register: (phone: string, code: string, password: string, nickname?: string) =>
    request<{ token: string; user: PublicUser }>("/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ phone, code, password, ...(nickname ? { nickname } : {}) }),
    }),
  loginPassword: (phone: string, password: string) =>
    request<{ token: string; user: PublicUser }>("/v1/auth/login", { method: "POST", body: JSON.stringify({ phone, password }) }),
  loginCode: (phone: string, code: string) =>
    request<{ token: string; user: PublicUser }>("/v1/auth/login", { method: "POST", body: JSON.stringify({ phone, code }) }),
  me: (token: string) => request<PublicUser>("/v1/auth/me", { token }),
  /** 注销账号：级联删除数据，不可恢复 */
  deleteAccount: (token: string) =>
    request<{ ok: boolean; deleted: Record<string, number> }>("/v1/auth/me", { method: "DELETE", token }),
  logout: (token: string) => request<{ ok: boolean }>("/v1/auth/logout", { method: "POST", token }),
};

/* ── 业务 ── */

export const api = {
  scenarios: (targetLang?: "en" | "ja" | "ko") =>
    request<{ scenarios: ScenarioSummary[] }>(`/v1/conversations/scenarios${targetLang ? `?targetLang=${targetLang}` : ""}`),
  startConversation: (token: string, scenarioId: string) =>
    request<StartResult>("/v1/conversations", { method: "POST", token, body: JSON.stringify({ scenarioId }) }),
  turn: (token: string, sessionId: string, text: string) =>
    request<TurnResult>(`/v1/conversations/${sessionId}/turns`, { method: "POST", token, body: JSON.stringify({ text }) }),
  endConversation: (token: string, sessionId: string) =>
    request<EndResult>(`/v1/conversations/${sessionId}/end`, { method: "POST", token }),
  review: (token: string, sessionId: string) =>
    request<ReviewReport>(`/v1/conversations/${sessionId}/review`, { method: "POST", token }),
  getReview: (token: string, sessionId: string) =>
    request<ReviewReport>(`/v1/conversations/${sessionId}/review`, { token }),
  vocabList: (token: string) =>
    request<{ cards: VocabCard[]; count: number }>("/v1/vocab", { token }),
  vocabDue: (token: string) =>
    request<{ cards: VocabCard[]; count: number }>("/v1/vocab/due", { token }),
  translateMessage: (token: string, text: string, lang: "en" | "ja" | "ko" = "en") =>
    request<MessageTranslation>("/v1/translate", {
      method: "POST",
      token,
      body: JSON.stringify({ text, lang }),
    }),
  vocabLookup: (token: string, word: string, context?: string, lang: "en" | "ja" | "ko" = "en") =>
    request<WordLookup>("/v1/vocab/lookup", {
      method: "POST",
      token,
      body: JSON.stringify({ word, ...(context ? { context } : {}), lang }),
    }),
  vocabAdd: (token: string, term: string, translation: string, context?: string) =>
    request<{ card: VocabCard; created: boolean }>("/v1/vocab", {
      method: "POST",
      token,
      body: JSON.stringify({ term, translation, ...(context ? { context } : {}) }),
    }),
  vocabGrade: (token: string, cardId: string, grade: 1 | 2 | 3 | 4) =>
    request<{ card: VocabCard }>(`/v1/vocab/${cardId}/review`, { method: "POST", token, body: JSON.stringify({ grade }) }),
  lecture: (token: string, cardId: string) =>
    request<{ term: string; lecture: VocabLecture; cached: boolean; chargedCents: number }>(`/v1/vocab/${cardId}/lecture`, { method: "POST", token }),
  updateMe: (token: string, patch: { nickname?: string; targetLang?: "en" | "ja" | "ko"; level?: "zero" | "basic" | "pro" }) =>
    request<PublicUser>("/v1/auth/me", { method: "PATCH", token, body: JSON.stringify(patch) }),
  stats: (token: string) => request<LearningProfile>("/v1/stats", { token }),
  wallet: (token: string) => request<WalletInfo>("/v1/wallet", { token }),
};
