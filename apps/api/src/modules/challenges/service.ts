/**
 * 闯关服务：状态查询 + 三种过关判定（跟读语音、情景对话轮数、任意对话轮数）+ 奖励发放
 * 奖励走钱包 grant（幂等键 challenge:<id>），过关记录一次性（user_challenges 主键约束）
 */
import type { Challenge, Exercise, CheckResult } from "../../content/challenges.js";
import { getChallenge, getUnit, unitExercises, checkExercise, checkPair, type ExerciseLevel } from "../../content/challenges.js";
import type { TargetLang } from "../../content/scenarios.js";

export interface ChallengeProgress {
  id: string;
  tier: Challenge["tier"];
  order: number;
  /** 所属单元（课程分组标题） */
  group: string;
  title: string;
  description: string;
  rewardCents: number;
  requiredTurns: number;
  /** completed=已完成 | open=可挑战 | locked=级内前一关未过 */
  state: "completed" | "open" | "locked";
  /** 历史最高星级（1-3；未完成 0） */
  stars: number;
  words: { text: string; display: string }[] | null;
  scenarioId: string | null;
}

export interface ClaimOutcome {
  /** 首次通关 */
  first: boolean;
  /** 本次是否升星（星级提高） */
  upgraded: boolean;
  /** 本次应发奖金（厘）：首通=全奖（调用方已按首错率缩放），升星=上次的一半 */
  payout: number;
  /** 记录后的最高星级 */
  stars: number;
}

export interface ChallengeRepo {
  listCompleted(userId: string): Promise<Set<string>>;
  /** 各关卡历史最高星级 */
  listStars(userId: string): Promise<Map<string, number>>;
  /**
   * 记录一次通关：
   * - 首通 → 插入（stars, paid=本关应发奖励）→ first=true
   * - 升星 → 星级取最高，奖金=上次 paid 的一半 → upgraded=true
   * - 无升星 → 只记账不发奖
   */
  recordClaim(userId: string, challengeId: string, stars: number, fullReward: number): Promise<ClaimOutcome>;
}

export class MemoryChallengeRepo implements ChallengeRepo {
  private readonly done = new Map<string, Set<string>>();
  private readonly stars = new Map<string, Map<string, number>>();
  private readonly paid = new Map<string, Map<string, number>>();
  async listCompleted(userId: string): Promise<Set<string>> {
    return this.done.get(userId) ?? new Set();
  }
  async recordClaim(userId: string, challengeId: string, stars: number, fullReward: number): Promise<ClaimOutcome> {
    let set = this.done.get(userId);
    if (!set) {
      set = new Set();
      this.done.set(userId, set);
    }
    const paid = this.paid.get(userId) ?? new Map<string, number>();
    const starsMap = this.stars.get(userId) ?? new Map<string, number>();
    this.paid.set(userId, paid);
    this.stars.set(userId, starsMap);
    const prevStars = set.has(challengeId) ? starsMap.get(challengeId) ?? 0 : 0;
    if (!set.has(challengeId)) {
      set.add(challengeId);
      starsMap.set(challengeId, stars);
      paid.set(challengeId, fullReward);
      return { first: true, upgraded: false, payout: fullReward, stars };
    }
    const best = Math.max(prevStars, stars);
    starsMap.set(challengeId, best);
    if (stars > prevStars) {
      const payout = Math.max(1, Math.floor((paid.get(challengeId) ?? 0) / 2));
      paid.set(challengeId, payout);
      return { first: false, upgraded: true, payout, stars: best };
    }
    return { first: false, upgraded: false, payout: 0, stars: best };
  }
  async listStars(userId: string): Promise<Map<string, number>> {
    return this.stars.get(userId) ?? new Map<string, number>();
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
  async recordClaim(userId: string, challengeId: string, stars: number, fullReward: number): Promise<ClaimOutcome> {
    const existing = await this.pool.query(
      "SELECT stars, paid_cents FROM user_challenges WHERE user_id = $1 AND challenge_id = $2",
      [userId, challengeId],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0] as { stars: number; paid_cents: number };
      const prevStars = Number(row.stars ?? 0);
      const prevPaid = Number(row.paid_cents ?? 0);
      if (stars > prevStars) {
        const best = Math.max(prevStars, stars);
        const payout = Math.max(1, Math.floor(prevPaid / 2));
        await this.pool.query(
          "UPDATE user_challenges SET stars = $3, paid_cents = $4 WHERE user_id = $1 AND challenge_id = $2",
          [userId, challengeId, best, payout],
        );
        return { first: false, upgraded: true, payout, stars: best };
      }
      return { first: false, upgraded: false, payout: 0, stars: prevStars };
    }
    await this.pool.query(
      "INSERT INTO user_challenges (user_id, challenge_id, stars, paid_cents, completed_at) VALUES ($1, $2, $3, $4, now())",
      [userId, challengeId, stars, fullReward],
    );
    return { first: true, upgraded: false, payout: fullReward, stars };
  }
  async listStars(userId: string): Promise<Map<string, number>> {
    const { rows } = await this.pool.query(
      "SELECT challenge_id, stars FROM user_challenges WHERE user_id = $1",
      [userId],
    );
    const map = new Map<string, number>();
    for (const r of rows) {
      const row = r as { challenge_id: string; stars: number };
      map.set(String(row.challenge_id), Number(row.stars ?? 0));
    }
    return map;
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

export type { Exercise, CheckResult };

export class ChallengeService {
  constructor(private readonly deps: ChallengeDeps) {}

  /** 混合练习题目（答案不下发，判题在服务端；难度随水平） */
  exercises(challengeId: string, level: ExerciseLevel = "zero"): Exercise[] {
    return unitExercises(challengeId, level);
  }

  /** 混合练习判题（read 题走 verifyWord 音频通道；level 与出题一致） */
  check(challengeId: string, index: number, answer: unknown, level: ExerciseLevel = "zero"): CheckResult {
    return checkExercise(challengeId, index, answer, level);
  }

  /** 连线逐对判定 */
  pair(challengeId: string, index: number, left: number, right: number, level: ExerciseLevel = "zero"): CheckResult {
    return checkPair(challengeId, index, left, right, level);
  }

  async list(userId: string, lang: TargetLang, all: Challenge[]): Promise<ChallengeProgress[]> {
    const completed = await this.deps.repo.listCompleted(userId);
    const stars = await this.deps.repo.listStars(userId);
    const out: ChallengeProgress[] = [];
    for (const tier of TIER_ORDER) {
      const tierChallenges = all.filter((c) => c.tier === tier).sort((a, b) => a.order - b.order);
      // 双轨解锁：词关链与对话关链各自顺序推进——词关过了下一单元就开，
      // 对话关是并行挑战线（不再卡住课程主线）
      const chainUnlocked: Record<string, boolean> = { words: true, dialogue: true };
      for (const c of tierChallenges) {
        const chain = c.id.endsWith("-dialogue") ? "dialogue" : "words";
        const state = completed.has(c.id) ? "completed" : chainUnlocked[chain] ? "open" : "locked";
        out.push({
          id: c.id,
          tier: c.tier,
          order: c.order,
          group: c.group,
          title: c.title,
          description: c.description,
          rewardCents: c.rewardCents,
          requiredTurns: c.requiredTurns,
          state,
          stars: stars.get(c.id) ?? (completed.has(c.id) ? 1 : 0),
          words: c.words?.map((w) => ({ text: w.text, display: w.display })) ?? null,
          scenarioId: c.scenarioId,
        });
        if (state !== "completed") chainUnlocked[chain] = false;
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

  /** 单词判定：一次一个词，客户端逐词上传（游戏化节奏，即时反馈） */
  async verifyWord(userId: string, challengeId: string, index: number, audioBase64: string): Promise<{ ok: boolean; transcript: string; why?: string }> {
    const c = getChallenge(challengeId);
    if (!c || c.tier !== "beginner" || !c.words) throw new Error("挑战不存在或不支持跟读");
    const word = c.words[index];
    if (!word) throw new Error("词序号越界");
    const transcript = await this.deps.transcribe(audioBase64, c.lang);
    const norm = (v: string): string => v.toLowerCase().replace(/\s/g, "");
    const t = norm(transcript);
    const ok = word.accept.some((a) => t.includes(norm(a)));
    const unit = getUnit(challengeId.replace(/-(words|dialogue)$/, ""));
    const cw = unit?.words[index];
    const why = cw ? `「${cw.term}」＝ ${cw.meaning}${cw.example ? `。例句：${cw.example}（${cw.exampleZh}）` : ""}` : undefined;
    const res: { ok: boolean; transcript: string; why?: string } = { ok, transcript };
    if (why) res.why = why;
    return res;
  }

  /** 初级过关领取（客户端在 matched ≥ 门槛后调用） */
  async claimBeginner(userId: string, challengeId: string, matched: number, all: Challenge[], threshold?: number, firstTry?: number, total?: number): Promise<{ rewardedCents: number; alreadyDone: boolean; stars: number }> {
    const c = getChallenge(challengeId);
    if (!c || c.tier !== "beginner") throw new Error("挑战不存在");
    const need = threshold ?? c.requiredTurns;
    if (matched < need) throw new Error(`还差 ${need - matched} 题`);
    // 星级（按首次正确率）：3★ 全对 / 2★ ≥70% / 1★ 通关
    let stars = 1;
    let reward = c.rewardCents;
    if (typeof firstTry === "number" && typeof total === "number" && total > 0) {
      const rate = Math.min(firstTry, total) / total;
      stars = rate >= 0.999 ? 3 : rate >= 0.7 ? 2 : 1;
      // 奖励随首次正确率缩放：满分全奖，错了按比例减
      if (firstTry < total) reward = Math.max(0, Math.round(c.rewardCents * rate));
    }
    const outcome = await this.deps.repo.recordClaim(userId, c.id, stars, reward);
    if (outcome.payout > 0) {
      await this.deps.grant(
        userId,
        outcome.payout,
        outcome.first
          ? `闯关成功：${c.title}${stars < 3 ? `（${stars}★ ×首次正确率）` : "（3★ 满分）"}`
          : `升星 ${outcome.stars}★：${c.title}（升星奖励减半）`,
        `challenge:${c.id}`,
      );
    }
    return { rewardedCents: outcome.payout, alreadyDone: !outcome.first, stars: outcome.stars };
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
        const outcome = await this.deps.repo.recordClaim(userId, c.id, 3, c.rewardCents);
        if (outcome.first) {
          await this.deps.grant(userId, outcome.payout, `对话通关：${c.title}（3★）`, `challenge:${c.id}`);
          completedNames.push(c.title);
        }
      }
    }
    return { completed: completedNames };
  }

  private langOfScenario(all: Challenge[], scenarioId: string): TargetLang | null {
    // 情景语言从挑战映射反查（避免引入情景内容依赖）
    for (const c of all) {
      if (c.scenarioId === scenarioId) return c.lang;
    }
    // 未映射的情景（如自由练习）：用后缀判断；无后缀默认英语
    if (scenarioId.endsWith("-ja")) return "ja";
    if (scenarioId.endsWith("-ko")) return "ko";
    return "en";
  }
}
