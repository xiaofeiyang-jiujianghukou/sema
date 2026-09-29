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
  words: CurriculumWord[];
  patterns: Array<{ pattern: string; meaning: string; example: string; exampleZh: string }>;
  dialogueGoal: string;
}

interface CurriculumWord {
  term: string;
  reading?: string;
  meaning: string;
  example: string;
  exampleZh: string;
  variants?: string[];
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
      description: `混合练习：跟读、选择、判断、完形、造句、连线，共 10 题`,
      rewardCents: 20 + 2 * (unit.order - 1),
      requiredTurns: 7,
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
      scenarioId: `${unit.id}-scene`,
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

// ═══ 混合练习：题型生成与判题 ═══

export type Exercise =
  | { type: "read"; wordIndex: number; word: string; display: string }
  | { type: "mc"; prompt: string; options: string[]; wordIndex: number }
  | { type: "tf"; prompt: string; wordIndex: number; shown: string }
  | { type: "cloze"; wordIndex: number; options: string[] }
  | { type: "build"; tiles: string[]; hint: string; sentence: string }
  | { type: "listen"; wordIndex: number; options: string[] }
  | { type: "match"; left: string[]; right: string[]; wordIndices: number[] };

export interface CheckResult {
  ok: boolean;
  /** 判错时给出正确答案（学习反馈） */
  correct?: string;
  /** 无论对错都给「为什么」——教学解释 */
  why?: string;
}

const normEx = (v: string): string => v.toLowerCase().replace(/[\s.,!?、。！？，]/g, "");

/** 字符串种子 → 确定性伪随机（同一关每次生成同一套题） */
function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function shuffled<T>(arr: readonly T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** 日/韩无空格：按助词/词尾切块（块与块拼接恒等于原句，判题不受切块质量影响） */
const JA_CUTS = ["から", "まで", "ました", "ません", "でした", "です", "ます", "は", "が", "を", "に", "で", "へ", "と", "も", "か", "ね", "よ"];
const KO_CUTS = ["에서", "에게", "합니다", "입니다", "이에요", "예요", "으로", "은", "는", "이", "가", "을", "를", "에", "도", "로"];
export function splitTiles(sentence: string): string[] {
  // 有空格的语言（英语等）：按词切
  if (sentence.includes(" ")) return sentence.split(/\s+/).filter(Boolean);
  const cuts = /[가-힣]/.test(sentence) ? KO_CUTS : JA_CUTS;
  const chars = [...sentence];
  const tiles: string[] = [];
  let cur = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === " " && cur.trim().length === 0) continue; // 块首空格跳过
    cur += ch;
    const rest = sentence.slice(i + 1);
    const hit = cuts.find((p) => rest.startsWith(p));
    if (hit && cur.trim().length >= 2) {
      cur += hit;
      i += hit.length;
      tiles.push(cur.trim());
      cur = "";
    } else if (/[。？！?!]/.test(ch)) {
      if (cur.trim()) tiles.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim()) tiles.push(cur.trim());
  // 标点彻底移除：判分按去标点拼接比较，标点块只会是送分作弊块
  const cleaned = tiles
    .map((t) => t.replace(/[。？！?!.,、]/g, "").trim())
    .filter((t) => t.length > 0);
  return cleaned;
}

/** 按单元 id 找到所属教材，返回全书词表（进阶难度：干扰项来自全书） */
export function getBookWords(unitId: string): CurriculumWord[] {
  for (const c of CURRICULA) {
    if (c.units.some((x) => x.id === unitId)) return c.units.flatMap((u) => u.words);
  }
  return [];
}

/** 干扰项：从词池里挑 n 个不同于正确项的释义/词 */
function pickDistractors(pool: CurriculumWord[], excludeTerm: string, get: (w: CurriculumWord) => string, n: number, rand: () => number): string[] {
  const out: string[] = [];
  for (const w of shuffled(pool, rand)) {
    const v = get(w);
    if (v !== excludeTerm && !out.includes(v) && out.length < n) out.push(v);
  }
  return out;
}

export type ExerciseLevel = "zero" | "basic" | "pro";

/** 生成一套混合练习（跟读×2 听音辨词×1 选择×2 判断×2 完形×1 造句×1 连线×1 = 10 题）
 *  难度随水平：入门 5 选项/进阶 6 选项；进阶干扰项来自全书、跟读卡不显示罗马音 */
export function unitExercises(challengeId: string, level: ExerciseLevel = "zero", seed = 0): Exercise[] {
  const unitId = challengeId.replace(/-(words|dialogue)$/, "");
  const unit = getUnit(unitId);
  if (!unit) throw new Error("课程单元不存在");
  // 种子 = 关卡 + 每局随机数：同一关卡每局出不同题，判题用同一局种子复现
  const rand = seededRandom(`${challengeId}:${seed}`);
  const words = unit.words;
  const optN = level === "pro" ? 6 : level === "basic" ? 5 : 4;
  const pool = level === "pro" ? getBookWords(unitId) : words;
  const out: Exercise[] = [];

  // 跟读 ×2（进阶：不显示罗马音提示）
  for (const wi of shuffled(words.map((_, i) => i), rand).slice(0, 2)) {
    const w = words[wi]!;
    out.push({ type: "read", wordIndex: wi, word: w.term, display: `${w.term}${w.reading && level !== "pro" ? `（${w.reading}）` : ""} · ${w.meaning}` });
  }
  // 听音辨词 ×1：AI 读词 → 选听到的词（进阶干扰项来自全书）
  {
    const wi = Math.floor(rand() * words.length);
    const w = words[wi]!;
    const distractors = pickDistractors(pool, w.term, (x) => x.term, optN - 1, rand);
    out.push({ type: "listen", wordIndex: wi, options: shuffled([w.term, ...distractors], rand) });
  }
  // 选择 ×2：词→义
  for (const wi of shuffled(words.map((_, i) => i), rand).slice(0, 2)) {
    const w = words[wi]!;
    const distractors = pickDistractors(pool, w.meaning, (x) => x.meaning, optN - 1, rand);
    out.push({ type: "mc", prompt: `「${w.term}」的意思是？`, options: shuffled([w.meaning, ...distractors], rand), wordIndex: wi });
  }
  // 判断 ×2：一半正确一半张冠李戴
  for (let k = 0; k < 2; k++) {
    const wi = Math.floor(rand() * words.length);
    const truthful = rand() > 0.5;
    const other = words[(wi + 1 + Math.floor(rand() * (words.length - 1))) % words.length]!;
    const shown = truthful ? words[wi]!.meaning : other.meaning;
    out.push({ type: "tf", prompt: `「${words[wi]!.term}」的意思是「${shown}」？`, wordIndex: wi, shown });
  }
  // 听句选句 ×2：AI 读完整例句 → 选听到的那句（音频即唯一解，
  // 从机制上排除 "We have _ for dinner" 任何食物都对的多解问题；
  // 选项为整句，与听音辨词的单词选项在玩法上区分）
  {
    const sentencePool = shuffled(words.map((_, i) => i), rand);
    for (const wi of sentencePool.slice(0, 2)) {
      const w = words[wi]!;
      const exs = new Set([w.example]);
      for (const oi of sentencePool) {
        if (exs.size >= optN) break;
        if (oi === wi) continue;
        const cand = words[oi]!.example;
        if (!exs.has(cand)) exs.add(cand);
      }
      // 本单元例句不够时用句型例句补位
      for (const p of unit.patterns) {
        if (exs.size >= optN) break;
        if (!exs.has(p.example)) exs.add(p.example);
      }
      out.push({ type: "cloze", wordIndex: wi, options: shuffled([...exs], rand) });
    }
  }
  // 造句 ×1：例句切词块（无标点）拼装还原
  const pIdx = Math.floor(rand() * unit.patterns.length);
  const pat = unit.patterns[pIdx]!;
  const tiles = shuffled(splitTiles(pat.example), rand);
  out.push({ type: "build", tiles, hint: pat.exampleZh, sentence: pat.example });
  // 连线 ×1：4 对词↔义
  const pairs = shuffled(words.map((_, i) => i), rand).slice(0, 4);
  out.push({ type: "match", left: pairs.map((i) => words[i]!.term), right: shuffled(pairs.map((i) => words[i]!.meaning), rand), wordIndices: pairs });

  return shuffled(out, rand);
}

/** 判题：按题型重算正确答案（答案不发给客户端） */
export function checkExercise(challengeId: string, index: number, answer: unknown, level: ExerciseLevel = "zero", seed = 0): CheckResult {
  // 必须与出题同一 level 重新生成同一序列——否则索引错位（egg 判成 juice 事故根源）
  const exercises = unitExercises(challengeId, level, seed);
  const ex = exercises[index];
  if (!ex) throw new Error("题目序号越界");
  const unitId = challengeId.replace(/-(words|dialogue)$/, "");
  const unit = getUnit(unitId)!;
  switch (ex.type) {
    case "mc": {
      const w = unit.words[ex.wordIndex]!;
      return { ok: answer === w.meaning, correct: w.meaning, why: `「${w.term}」＝ ${w.meaning}${w.reading ? `（${w.reading}）` : ""}` };
    }
    case "tf": {
      const w = unit.words[ex.wordIndex]!;
      const truthful = w.meaning === ex.shown;
      return { ok: answer === truthful, why: truthful ? `「${w.term}」就是「${w.meaning}」——题目说法正确` : `「${w.term}」其实是「${w.meaning}」，不是「${ex.shown}」` };
    }
    case "cloze": {
      const w = unit.words[ex.wordIndex]!;
      const ok = normEx(String(answer)) === normEx(w.example);
      return { ok, correct: w.example, why: `听到的就是：${w.example}（${w.exampleZh}）——「${w.term}」＝ ${w.meaning}` };
    }
    case "build": {
      const tiles = Array.isArray(answer) ? (answer as unknown[]).map(String) : [];
      const ok = normEx(tiles.join("")) === normEx(ex.sentence);
      return { ok, correct: ex.sentence, why: `原句：${ex.sentence}（${ex.hint}）` };
    }
    case "listen": {
      const w = unit.words[ex.wordIndex]!;
      const ok = normEx(String(answer)) === normEx(w.term);
      return { ok, correct: w.term, why: `读的是「${w.term}」＝ ${w.meaning}${w.reading ? `（${w.reading}）` : ""}` };
    }
    case "match": {
      const mapping = Array.isArray(answer) ? (answer as unknown[]).map((v) => Number(v)) : [];
      const ok = ex.left.every((_, li) => {
        const correctRi = ex.right.findIndex((r) => r === unit.words[ex.wordIndices[li]!]!.meaning);
        return mapping[li] === correctRi;
      });
      return { ok, why: ex.left.map((l, li) => `${l}＝${unit.words[ex.wordIndices[li]!]!.meaning}`).join("；") };
    }
    default:
      return { ok: false };
  }
}

/** 连线逐对判定：left/right 为题目内下标；正确→锁定，错误→❗重选 */
export function checkPair(challengeId: string, index: number, left: number, right: number, level: ExerciseLevel = "zero", seed = 0): CheckResult {
  const exercises = unitExercises(challengeId, level, seed);
  const ex = exercises[index];
  if (!ex || ex.type !== "match") throw new Error("该题不是连线题");
  const unitId = challengeId.replace(/-(words|dialogue)$/, "");
  const unit = getUnit(unitId)!;
  const leftWord = unit.words[ex.wordIndices[left]!];
  return { ok: ex.right[right] === leftWord!.meaning, why: `「${leftWord!.term}」＝ ${leftWord!.meaning}` };
}

/** 按单元 id 取课程单元（混合练习出题用） */
export function getUnit(unitId: string): CurriculumUnit | undefined {
  for (const c of CURRICULA) {
    const u = c.units.find((x) => x.id === unitId);
    if (u) return u;
  }
  return undefined;
}

/** 课程元信息（供展示） */
export function courseInfo(lang: TargetLang): { title: string; band: string; units: number } | null {
  const c = CURRICULA.find((x) => x.lang === lang);
  return c ? { title: c.title, band: c.band, units: c.units.length } : null;
}
