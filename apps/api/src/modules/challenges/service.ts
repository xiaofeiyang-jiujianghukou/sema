/**
 * 闯关服务：状态查询 + 三种过关判定（跟读语音、情景对话轮数、任意对话轮数）+ 奖励发放
 * 奖励走钱包 grant（幂等键 challenge:<id>），过关记录一次性（user_challenges 主键约束）
 */
import type { Challenge } from "../../content/challenges.js";
import { getChallenge } from "../../content/challenges.js";
import type { TargetLang } from "../../content/scenarios.js";

export interface ChallengeProgress {
  id: string;
  tier: Challenge["tier"];
  order: number;
  title: string;
  description: string;
  rewardCents: number;
  requiredTurns: number;
  /** completed=已完成 | open=可挑战 | locked=级内前一关未过 */
  state: "completed" | "open" | "locked";
  words: { text: string; display: string }[] | null;
  scenarioId: string | null;
}

export interface ChallengeRepo {
  listCompleted(userId: string): Promise<Set<string>>;
  /** 已完成返回 false（幂等） */
  markCompleted(userId: string, challengeId: string): Promise<boolean>;
}

export class MemoryChallengeRepo implements ChallengeRepo {
  private readonly done = new Map<string, Set<string>>();
  async listCompleted(userId: string): Promise<Set<string>> {
    return this.done.get(userId) ?? new Set();
  }
  async markCompleted(userId: string, challengeId: string): Promise<boolean> {
    let set = this.done.get(userId);
    if (!set) {
      set = new Set();
      this.done.set(userId, set);
    }
    if (set.has(challengeId)) return false;
    set.add(challengeId);
    return true;
  }
}

export class DrizzleChallengeRepo implements ChallengeRepo {
  constructor(private readonly pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) {}
  async listCompleted(userId: string): Promise<Set<string>> {
    const { rows } = await this.pool.query(
      "SELECT challenge_id FROM user_challenges WHERE user_id = $1",
      [userId],
    );
    return new Set(rows.map((r) => String((r as { challenge_id: string }).challenge_id)));
  }
  async markCompleted(userId: string, challengeId: string): Promise<boolean> {
    try {
      await this.pool.query(
        "INSERT INTO user_challenges (user_id, challenge_id, completed_at) VALUES ($1, $2, now())",
        [userId, challengeId],
      );
      return true;
    } catch {
      return false; // 唯一约束冲突 = 已完成
    }
  }
}

/** 会话轮数与归属（由对话仓储提供） */
export interface ChallengeSession {
  userId: string;
  scenarioId: string;
  userTurns: number;
}

export interface ChallengeDeps {
  repo: ChallengeRepo;
  /** 完成挑战 → 钱包发奖（幂等） */
  grant: (userId: string, cents: number, reason: string, idemKey: string) => Promise<void>;
  /** 按 id 查会话（判轮数） */
  getSession: (sessionId: string) => Promise<ChallengeSession | null>;
  /** 初级跟读：整段音频（AAC base64）→ ASR 文本 */
  transcribe: (audioBase64: string, lang: TargetLang) => Promise<string>;
}

const TIER_ORDER: Challenge["tier"][] = ["beginner", "intermediate", "advanced"];

export class ChallengeService {
  constructor(private readonly deps: ChallengeDeps) {}

  async list(userId: string, lang: TargetLang, all: Challenge[]): Promise<ChallengeProgress[]> {
    const completed = await this.deps.repo.listCompleted(userId);
    const out: ChallengeProgress[] = [];
    for (const tier of TIER_ORDER) {
      const tierChallenges = all.filter((c) => c.tier === tier).sort((a, b) => a.order - b.order);
      let unlocked = true;
      for (const c of tierChallenges) {
        const state = completed.has(c.id) ? "completed" : unlocked ? "open" : "locked";
        out.push({
          id: c.id,
          tier: c.tier,
          order: c.order,
          title: c.title,
          description: c.description,
          rewardCents: c.rewardCents,
          requiredTurns: c.requiredTurns,
          state,
          words: c.words?.map((w) => ({ text: w.text, display: w.display })) ?? null,
          scenarioId: c.scenarioId,
        });
        if (state !== "completed") unlocked = false;
      }
    }
    return out;
  }

  /** 初级跟读：单次上传整段（用户连读若干词），服务端 ASR 后逐一匹配 */
  async verifyVoice(
    userId: string,
    challengeId: string,
    audioBase64: string,
    all: Challenge[],
  ): Promise<{ results: { text: string; display: string; ok: boolean }[]; matched: number; threshold: number }> {
    const c = getChallenge(challengeId);
    if (!c || c.tier !== "beginner" || !c.words) throw new Error("挑战不存在或不支持跟读");
    const transcript = await this.deps.transcribe(audioBase64, c.lang);
    const norm = (s: string): string => s.toLowerCase().replace(/[\s.,!?、。！？，]/g, "");
    const t = norm(transcript);
    const results = c.words.map((w) => ({
      text: w.text,
      display: w.display,
      ok: w.accept.some((a) => t.includes(norm(a))),
    }));
    const matched = results.filter((r) => r.ok).length;
    return { results, matched, threshold: c.requiredTurns };
  }

  /** 初级过关领取（客户端在 matched ≥ 门槛后调用） */
  async claimBeginner(userId: string, challengeId: string, matched: number, all: Challenge[]): Promise<{ rewardedCents: number; alreadyDone: boolean }> {
    const c = getChallenge(challengeId);
    if (!c || c.tier !== "beginner") throw new Error("挑战不存在");
    if (matched < c.requiredTurns) throw new Error(`还需读对 ${c.requiredTurns - matched} 个词`);
    return this.finish(userId, c);
  }

  /** 中级/高级：用会话轮数判定（session-attempt：对该语言所有未完成的对话型挑战逐一尝试） */
  async attemptSession(userId: string, sessionId: string, all: Challenge[]): Promise<{ completed: string[] }> {
    const session = await this.deps.getSession(sessionId);
    if (!session || session.userId !== userId) return { completed: [] };
    const lang = this.langOfScenario(all, session.scenarioId);
    if (!lang) return { completed: [] };
    const completedNames: string[] = [];
    for (const c of all.filter((x) => x.lang === lang && x.words === null)) {
      if (session.userTurns < c.requiredTurns) continue;
      if (!c.scenarioId || c.scenarioId === session.scenarioId) {
        const res = await this.finish(userId, c);
        if (!res.alreadyDone) completedNames.push(c.title);
      }
    }
    return { completed: completedNames };
  }

  private async finish(userId: string, c: Challenge): Promise<{ rewardedCents: number; alreadyDone: boolean }> {
    const first = await this.deps.repo.markCompleted(userId, c.id);
    if (!first) return { rewardedCents: 0, alreadyDone: true };
    await this.deps.grant(userId, c.rewardCents, `闯关成功：${c.title}`, `challenge:${c.id}`);
    return { rewardedCents: c.rewardCents, alreadyDone: false };
  }

  private langOfScenario(all: Challenge[], scenarioId: string): TargetLang | null {
    // 情景语言从挑战映射反查（避免引入情景内容依赖）
    for (const c of all) {
      if (c.scenarioId === scenarioId) return c.lang;
    }
    // 未映射的情景（如自由练习）：用前缀判断
    if (/-(ja|ko)$/.test(scenarioId)) return scenarioId.endsWith("-ja") ? "ja" : "ko";
    return null;
  }
}
