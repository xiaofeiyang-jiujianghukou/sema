/**
 * 学习档案——终身学习的数据面
 *
 * 全部从已有领域数据聚合（会话/复盘/生词），不引入新的事实来源：
 * - 口语投入：会话数、总时长、开口次数、累计消费
 * - 词汇增长：生词总量、7 天新增、当前到期数
 - - 活跃度：近 14 天每日时长（曲线用）+ 连续学习天数
 */
import type { ConversationSession } from "../conversation/repo.js";
import type { ConversationRepo } from "../conversation/repo.js";
import type { ReviewRepo } from "../review/service.js";
import type { VocabBookService } from "../vocab/service.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DayActivity {
  /** UTC 日期 YYYY-MM-DD */
  date: string;
  seconds: number;
  turns: number;
}

export interface LearningProfile {
  userId: string;
  sessions: number;
  totalSeconds: number;
  turns: number;
  totalBilledCents: number;
  vocab: { total: number; dueNow: number; addedLast7Days: number; reviewsDone: number };
  streakDays: number;
  activity: DayActivity[];
}

export interface StatsDeps {
  now: () => number;
}

export class StatsService {
  constructor(
    private readonly conversations: ConversationRepo,
    private readonly reviews: ReviewRepo,
    private readonly vocab: VocabBookService,
    private readonly deps: StatsDeps = { now: Date.now },
  ) {}

  async profile(userId: string): Promise<LearningProfile> {
    const now = this.deps.now();
    const sessions = await this.conversations.listByUser(userId);
    const reviews = await this.reviews.listByUser(userId);
    const cards = await this.vocab.list(userId);

    let totalSeconds = 0;
    let turns = 0;
    let totalBilledCents = 0;
    const byDay = new Map<string, DayActivity>();

    for (const session of sessions) {
      const end = session.endedAtMs ?? session.lastBilledAtMs;
      const seconds = Math.max(0, Math.floor((end - session.startedAtMs) / 1000));
      totalSeconds += seconds;
      totalBilledCents += session.totalBilledCents;
      turns += session.history.filter((m) => m.role === "user").length;

      const date = new Date(session.startedAtMs).toISOString().slice(0, 10);
      const day = byDay.get(date) ?? { date, seconds: 0, turns: 0 };
      day.seconds += seconds;
      day.turns += session.history.filter((m) => m.role === "user").length;
      byDay.set(date, day);
    }

    const dueNow = (await this.vocab.due(userId, now)).length;
    const addedLast7Days = cards.filter((c) => now - c.createdAtMs < 7 * DAY_MS).length;
    const reviewsDone = cards.reduce((acc, c) => acc + c.reviewCount, 0);

    // 连续天数：从今天（或昨天）往回数，每天都得有会话
    const activeDays = new Set(sessions.map((s) => new Date(s.startedAtMs).toISOString().slice(0, 10)));
    let streakDays = 0;
    const today = new Date(now);
    const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    if (!activeDays.has(cursor.toISOString().slice(0, 10))) {
      cursor.setTime(cursor.getTime() - DAY_MS); // 今天还没学，从昨天起算
    }
    while (activeDays.has(cursor.toISOString().slice(0, 10))) {
      streakDays += 1;
      cursor.setTime(cursor.getTime() - DAY_MS);
    }

    const activity: DayActivity[] = [];
    for (let i = 13; i >= 0; i -= 1) {
      const d = new Date(now - i * DAY_MS).toISOString().slice(0, 10);
      activity.push(byDay.get(d) ?? { date: d, seconds: 0, turns: 0 });
    }

    return {
      userId,
      sessions: sessions.length,
      totalSeconds,
      turns,
      totalBilledCents,
      vocab: { total: cards.length, dueNow, addedLast7Days, reviewsDone },
      streakDays,
      activity,
    };
  }
}

export type { ConversationSession };
