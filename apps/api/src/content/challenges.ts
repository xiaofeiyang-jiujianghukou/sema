/**
 * 闯关内容 v2：由真实课程大纲（curriculum/*.json）驱动
 * 英语对齐 CEFR A1、日语对齐 JLPT N5、韩语对齐 TOPIK I
 * 每单元派生两关：词表跟读（AI 听读）+ 对话应用（轮数门槛），难度与奖励随单元递增
 */
import type { TargetLang } from "./scenarios.js";
import enA1 from "./curriculum/en-a1.json" with { type: "json" };
import jaN5 from "./curriculum/ja-n5.json" with { type: "json" };
import koTopik1 from "./curriculum/ko-topik1.json" with { type: "json" };

export type ChallengeTier = "beginner" | "intermediate" | "advanced";

export interface ChallengeWord {
  /** 目标说法（ASR 应听到的） */
  text: string;
  /** 给学习者看的：目标语言 + 中文 + 罗马音提示 */
  display: string;
  /** 可接受的匹配（含罗马音/数字转写等变体） */
  accept: string[];
}

export interface Challenge {
  id: string;
  lang: TargetLang;
  tier: ChallengeTier;
  /** 级内顺序（从 1 开始，级内顺序解锁） */
  order: number;
  /** 所属单元（课程分组标题） */
  group: string;
  title: string;
  description: string;
  /** 过关奖励（厘） */
  rewardCents: number;
  /** 跟读关：需匹配词数；对话应用关：要求用户发言轮数 */
  requiredTurns: number;
  /** 跟读关词表；对话应用关为 null */
  words: ChallengeWord[] | null;
  scenarioId: string | null;
}

interface CurriculumUnit {
  id: string;
  order: number;
  title: string;
  words: Array<{ term: string; reading?: string; meaning: string; example: string; exampleZh: string; variants?: string[] }>;
  patterns: Array<{ pattern: string; meaning: string; example: string; exampleZh: string }>;
  dialogueGoal: string;
}

interface Curriculum {
  courseId: string;
  lang: TargetLang;
  band: string;
  title: string;
  description: string;
  units: CurriculumUnit[];
}

const CURRICULA: Curriculum[] = [enA1, jaN5, koTopik1].map((c) => c as unknown as Curriculum);

const norm = (s: string): string => s.toLowerCase().replace(/[\s.,!?、。！？，～]/g, "");

/** 从词义里提取数字变体（いち→1、하나→1、one→1），兼容 ASR 的 ITN 数字转写 */
function digitVariants(meaning: string): string[] {
  return [...new Set(meaning.match(/\d+/g) ?? [])];
}

function buildWords(unit: CurriculumUnit, lang: TargetLang): ChallengeWord[] {
  return unit.words.map((w) => {
    const readingHint = w.reading && norm(w.reading) !== norm(w.term) ? `（${w.reading}）` : "";
    const display = lang === "en" ? `${w.term} · ${w.meaning}` : `${w.term}${readingHint} · ${w.meaning}`;
    const accept = [w.term, ...(w.reading ? [w.reading] : []), ...(w.variants ?? []), ...digitVariants(w.meaning)];
    return { text: w.term, display, accept };
  });
}

/** 对话应用关的轮数门槛：u1-3=6 轮、u4-6=8 轮、u7+=10 轮（越往后越苛刻） */
function dialogueTurns(order: number): number {
  if (order <= 3) return 6;
  if (order <= 6) return 8;
  return 10;
}

function buildChallenges(curriculum: Curriculum): Challenge[] {
  const list: Challenge[] = [];
  for (const unit of curriculum.units) {
    list.push({
      id: `${unit.id}-words`,
      lang: curriculum.lang,
      tier: "beginner",
      order: unit.order * 2 - 1,
      group: `${curriculum.band} · 第${unit.order}单元 ${unit.title}`,
      title: `第${unit.order}课 · 词表跟读（${unit.title}）`,
      description: `朗读本课 ${unit.words.length} 个词，读对 ${Math.ceil(unit.words.length * 0.8)} 个过关`,
      rewardCents: 20 + 2 * (unit.order - 1),
      requiredTurns: Math.ceil(unit.words.length * 0.8),
      words: buildWords(unit, curriculum.lang),
      scenarioId: null,
    });
    list.push({
      id: `${unit.id}-dialogue`,
      lang: curriculum.lang,
      tier: "intermediate",
      order: unit.order * 2,
      group: `${curriculum.band} · 第${unit.order}单元 ${unit.title}`,
      title: `第${unit.order}课 · 对话应用`,
      description: `情景目标：${unit.dialogueGoal}——完成 ${dialogueTurns(unit.order)} 轮对话`,
      rewardCents: 50 + 5 * (unit.order - 1),
      requiredTurns: dialogueTurns(unit.order),
      words: null,
      scenarioId: null,
    });
  }
  return list;
}

export const CHALLENGES: Challenge[] = CURRICULA.flatMap((c) => buildChallenges(c));

export function challengesForLang(lang: TargetLang): Challenge[] {
  return CHALLENGES.filter((c) => c.lang === lang);
}

export function getChallenge(id: string): Challenge | undefined {
  return CHALLENGES.find((c) => c.id === id);
}

/** 课程元信息（供展示） */
export function courseInfo(lang: TargetLang): { title: string; band: string; units: number } | null {
  const c = CURRICULA.find((x) => x.lang === lang);
  return c ? { title: c.title, band: c.band, units: c.units.length } : null;
}
