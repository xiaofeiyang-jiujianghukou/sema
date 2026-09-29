/**
 * 闯关内容：每门语言 × 三级学习路径（初级=单词跟读、中级=情景对话、高级=自由语音对话）
 *
 * 产品规则（用户 2026-09 定稿）：
 * - 登录默认上次课程；按课程+水平路由学习路径
 * - 每级闯关成功奖励积分，越高级奖励越多、达成条件越苛刻
 * - 高级的「一对一视频语音」为 roadmap：当前以真实语速自由语音对话承载
 */
import type { TargetLang } from "./scenarios.js";

export type ChallengeTier = "beginner" | "intermediate" | "advanced";

export interface ChallengeWord {
  /** 目标说法（ASR 应听到的） */
  text: string;
  /** 给学习者看的：目标语言 + 中文 + 罗马音提示 */
  display: string;
  /** 可接受的匹配（含 ITN 数字形态等变体） */
  accept: string[];
}

export interface Challenge {
  id: string;
  lang: TargetLang;
  tier: ChallengeTier;
  /** 级内顺序（从 1 开始，级内顺序解锁） */
  order: number;
  title: string;
  description: string;
  /** 过关奖励（厘） */
  rewardCents: number;
  /** 中级/高级：要求的用户发言轮数；初级：需匹配的词数门槛 */
  requiredTurns: number;
  /** 初级：跟读词表；中级：指定情景 id；高级：null = 该语言任意情景 */
  words: ChallengeWord[] | null;
  scenarioId: string | null;
}

const W = (text: string, display: string, accept: string[]): ChallengeWord => ({ text, display, accept });

const BEGINNER_EN: ChallengeWord[][] = [
  [
    W("hello", "hello · 你好", ["hello", "hi"]),
    W("thank you", "thank you · 谢谢", ["thank you", "thanks"]),
    W("sorry", "sorry · 对不起", ["sorry", "so sorry"]),
    W("please", "please · 请", ["please"]),
    W("goodbye", "goodbye · 再见", ["goodbye", "bye", "good bye"]),
  ],
  [
    W("coffee", "coffee · 咖啡", ["coffee"]),
    W("milk", "milk · 牛奶", ["milk"]),
    W("water", "water · 水", ["water"]),
    W("bread", "bread · 面包", ["bread"]),
    W("egg", "egg · 鸡蛋", ["egg", "eggs"]),
  ],
  [
    W("one", "one · 1", ["one", "1"]),
    W("two", "two · 2", ["two", "2", "to", "too"]),
    W("three", "three · 3", ["three", "3", "free"]),
    W("four", "four · 4", ["four", "4", "for"]),
    W("five", "five · 5", ["five", "5"]),
  ],
];

const BEGINNER_JA: ChallengeWord[][] = [
  [
    W("こんにちは", "こんにちは · 你好（konnichiwa）", ["こんにちは", "こんちは"]),
    W("ありがとう", "ありがとう · 谢谢（arigatou）", ["ありがとう", "ありがとうございます"]),
    W("すみません", "すみません · 不好意思（sumimasen）", ["すみません"]),
    W("おはよう", "おはよう · 早上好（ohayou）", ["おはよう", "おはようございます"]),
    W("さようなら", "さようなら · 再见（sayounara）", ["さようなら", "さようなら", "バイバイ"]),
  ],
  [
    W("いち", "いち · 1（ichi）", ["いち", "1", "一"]),
    W("に", "に · 2（ni）", ["に", "2", "二"]),
    W("さん", "さん · 3（san）", ["さん", "3", "三"]),
    W("よん", "よん · 4（yon）", ["よん", "4", "し", "四"]),
    W("ご", "ご · 5（go）", ["ご", "5", "五"]),
  ],
  [
    W("みず", "みず · 水（mizu）", ["みず", "水"]),
    W("ごはん", "ごはん · 米饭（gohan）", ["ごはん", "ご飯", "ごはん"]),
    W("パン", "パン · 面包（pan）", ["パン"]),
    W("たまご", "たまご · 鸡蛋（tamago）", ["たまご", "卵", "玉子"]),
    W("ぎゅうにゅう", "ぎゅうにゅう · 牛奶（gyuunyuu）", ["ぎゅうにゅう", "牛乳"]),
  ],
];

const BEGINNER_KO: ChallengeWord[][] = [
  [
    W("안녕하세요", "안녕하세요 · 你好（annyeonghaseyo）", ["안녕하세요", "안녕하십니까"]),
    W("감사합니다", "감사합니다 · 谢谢（gamsahamnida）", ["감사합니다", "고맙습니다"]),
    W("죄송합니다", "죄송합니다 · 对不起（joesonghamnida）", ["죄송합니다", "미안합니다"]),
    W("네", "네 · 是（ne）", ["네", "네에"]),
    W("아니요", "아니요 · 不是（aniyo）", ["아니요", "아니에요", "아니오"]),
  ],
  [
    W("하나", "하나 · 1（hana）", ["하나", "1", "일"]),
    W("둘", "둘 · 2（dul）", ["둘", "2", "이"]),
    W("셋", "셋 · 3（set）", ["셋", "3", "삼"]),
    W("넷", "넷 · 4（net）", ["넷", "4", "사"]),
    W("다섯", "다섯 · 5（daseot）", ["다섯", "5", "오"]),
  ],
  [
    W("물", "물 · 水（mul）", ["물"]),
    W("밥", "밥 · 米饭（bap）", ["밥"]),
    W("빵", "빵 · 面包（ppang）", ["빵"]),
    W("계란", "계란 · 鸡蛋（gyeran）", ["계란", "달걀"]),
    W("우유", "우유 · 牛奶（uyu）", ["우유"]),
  ],
];

const INTERMEDIATE: Record<TargetLang, Array<{ scenarioId: string; title: string; turns: number; reward: number }>> = {
  en: [
    { scenarioId: "coffee-order", title: "咖啡店点单", turns: 8, reward: 60 },
    { scenarioId: "hotel-checkin", title: "酒店入住", turns: 8, reward: 80 },
    { scenarioId: "job-interview", title: "英文面试", turns: 8, reward: 100 },
  ],
  ja: [
    { scenarioId: "cafe-order-ja", title: "カフェで注文 · 咖啡店点单", turns: 8, reward: 60 },
    { scenarioId: "konbini-lunch-ja", title: "コンビニ · 便利店午餐", turns: 8, reward: 80 },
    { scenarioId: "ramen-counter-ja", title: "ラーメン · 拉面店点餐", turns: 8, reward: 100 },
  ],
  ko: [
    { scenarioId: "cafe-order-ko", title: "카페 주문 · 咖啡店点单", turns: 8, reward: 60 },
    { scenarioId: "kimbap-shop-ko", title: "김밥 가게 · 紫菜包饭店", turns: 8, reward: 80 },
    { scenarioId: "korean-bbq-ko", title: "고깃집 · 烤肉店", turns: 8, reward: 100 },
  ],
};

const ADVANCED: Record<TargetLang, Array<{ turns: number; reward: number }>> = {
  en: [
    { turns: 10, reward: 120 },
    { turns: 16, reward: 180 },
  ],
  ja: [
    { turns: 10, reward: 120 },
    { turns: 16, reward: 180 },
  ],
  ko: [
    { turns: 10, reward: 120 },
    { turns: 16, reward: 180 },
  ],
};

function beginnerWords(lang: TargetLang, order: number): ChallengeWord[] {
  const bank = lang === "en" ? BEGINNER_EN : lang === "ja" ? BEGINNER_JA : BEGINNER_KO;
  const words = bank[order - 1];
  if (!words) throw new Error(`初级词表缺失: ${lang} #${order}`);
  return words;
}

function buildChallenges(lang: TargetLang): Challenge[] {
  const list: Challenge[] = [];
  const beginnerTitles = ["第一关 · 问候与礼貌", "第二关 · 食物饮品", "第三关 · 数字 1-5"];
  const beginnerRewards = [20, 30, 40];
  for (let i = 1; i <= 3; i++) {
    list.push({
      id: `${lang}-beginner-${i}`,
      lang,
      tier: "beginner",
      order: i,
      title: beginnerTitles[i - 1] ?? `第${i}关`,
      description: "看词开口读，5 个读对 4 个即过关（AI 听你读）",
      rewardCents: beginnerRewards[i - 1] ?? 20,
      requiredTurns: 4,
      words: beginnerWords(lang, i),
      scenarioId: null,
    });
  }
  for (let i = 0; i < 3; i++) {
    const c = INTERMEDIATE[lang][i];
    if (!c) throw new Error(`中级挑战缺失: ${lang} #${i + 1}`);
    list.push({
      id: `${lang}-intermediate-${i + 1}`,
      lang,
      tier: "intermediate",
      order: i + 1,
      title: `第${["一", "二", "三"][i]}关 · ${c.title}`,
      description: `在指定情景完成 ${c.turns} 轮对话（语音或文字）`,
      rewardCents: c.reward,
      requiredTurns: c.turns,
      words: null,
      scenarioId: c.scenarioId,
    });
  }
  for (let i = 0; i < 2; i++) {
    const c = ADVANCED[lang][i];
    if (!c) throw new Error(`高级挑战缺失: ${lang} #${i + 1}`);
    list.push({
      id: `${lang}-advanced-${i + 1}`,
      lang,
      tier: "advanced",
      order: i + 1,
      title: `第${["一", "二"][i]}关 · 自由语音对决`,
      description: `任意情景完成 ${c.turns} 轮真实语速对话（视频通话即将推出）`,
      rewardCents: c.reward,
      requiredTurns: c.turns,
      words: null,
      scenarioId: null,
    });
  }
  return list;
}

export const CHALLENGES: Challenge[] = [
  ...buildChallenges("en"),
  ...buildChallenges("ja"),
  ...buildChallenges("ko"),
];

export function challengesForLang(lang: TargetLang): Challenge[] {
  return CHALLENGES.filter((c) => c.lang === lang);
}

export function getChallenge(id: string): Challenge | undefined {
  return CHALLENGES.find((c) => c.id === id);
}
