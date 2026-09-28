/**
 * 情景内容资产（M1 · 3 个精品情景，中→英）
 *
 * 这是「内容资产化」策略的载体：AI 预生成 + 人工打磨，一次生产、
 * 无限用户复用（边际成本≈0），是价目表里毛利最高的付费点。
 *
 * 质量标准（docs/product.md §3）：
 * - opener 必须是地道英文、30 秒内把用户带进对话
 * - AI 角色有性格、有目标，不端着不念稿
 * - 纠错策略：对话中只做「自然示范」，集中纠错留给结束后的复盘报告（M2）
 */

export type Difficulty = "A1" | "A2" | "B1" | "B2";

export interface Scenario {
  id: string;
  sourceLang: "zh";
  targetLang: "en";
  /** 用户端展示标题（中文） */
  title: string;
  titleEn: string;
  emoji: string;
  difficulty: Difficulty;
  persona: {
    name: string;
    role: string;
    personality: string;
  };
  /** 给用户看的一句话情景说明 */
  setting: string;
  /** AI 首句（预生成资产：0 成本、即时返回，30 秒开口的第一块砖） */
  opener: string;
  /** 用户在本情景要完成的语言任务（复盘报告的评分依据） */
  goals: string[];
  /** 目标词汇/表达（进入 SRS 的种子） */
  targetVocab: string[];
  /** 导师人设 prompt（含纠错策略与难度校准） */
  systemPrompt: string;
}

const CORRECTION_POLICY =
  "Correction policy: stay 100% in character and reply naturally FIRST. " +
  "If the learner makes a language mistake, model the correct phrasing naturally " +
  "inside your reply (recast, not lecture). Never break character to explain grammar. " +
  "Always end with a short follow-up question to keep them talking.";

const COMMON_RULES =
  "You are roleplaying with a Chinese learner of English. " +
  "Speak ONLY natural English (the learner may type Chinese; gently keep replying in English). " +
  "Keep every reply short (1-2 sentences), warm, and easy to respond to.";

// 人设模板字符串（必须先于 SCENARIOS 声明）
const PERSONA_COFFEE =
  "a friendly barista at The Daily Grind, a busy London coffee shop. " +
  "Personality: cheerful, a little chatty, loves recommending pastries.";
const PERSONA_INTERVIEW =
  "a warm but sharp hiring manager at a tech company. " +
  "Personality: one question at a time, genuine encouragement, professional but human.";
const PERSONA_DIRECTIONS =
  "a friendly London local walking her dog near King's Cross. " +
  "Personality: easygoing, patient, adds tiny local tips.";

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "coffee-order",
    sourceLang: "zh",
    targetLang: "en",
    title: "伦敦咖啡店点单",
    titleEn: "The Daily Grind",
    emoji: "☕",
    difficulty: "A2",
    persona: {
      name: "Ben",
      role: "friendly barista at The Daily Grind, a busy London coffee shop",
      personality: "cheerful, a little chatty, loves recommending pastries",
    },
    setting: "伦敦工作日早上 8 点，你在咖啡店排队点早餐咖啡，前面只有两个人。",
    opener: "Morning! Lovely day innit — what can I get started for you?",
    goals: [
      "点出一杯具体的咖啡（种类 + 尺寸）",
      "说明加奶/加糖偏好",
      "听懂并回答堂食还是带走",
    ],
    targetVocab: [
      "I'd like ... / Could I get ...",
      "for here or to go",
      "oat milk / semi-skimmed",
      "a shot of espresso",
      "Anything else?",
    ],
    systemPrompt: `${COMMON_RULES} You are Ben, ${PERSONA_COFFEE} Speak slowly with everyday A2 vocabulary (sizes, milk, sugar, prices). ${CORRECTION_POLICY}`,
  },
  {
    id: "job-interview",
    sourceLang: "zh",
    targetLang: "en",
    title: "第一次英文面试",
    titleEn: "The Interview",
    emoji: "💼",
    difficulty: "B1",
    persona: {
      name: "Ms. Park",
      role: "hiring manager interviewing a candidate for an entry-level role at a tech company",
      personality: "warm but sharp, asks one question at a time, gives genuine encouragement",
    },
    setting: "视频面试前 1 分钟，对方刚打开摄像头，冲你点了点头。",
    opener:
      "Thanks for making the time today. So — why don't you start by telling me a bit about yourself?",
    goals: [
      "完成 30 秒自我介绍（背景 + 一项优势）",
      "用一个具体例子回答行为问题",
      "向面试官提出至少一个问题",
    ],
    targetVocab: [
      "I have experience in ...",
      "My strength is ... / I'm good at ...",
      "For example, ...",
      "Could you tell me more about the team?",
    ],
    systemPrompt: `${COMMON_RULES} You are Ms. Park, ${PERSONA_INTERVIEW} Use B1 workplace language; ask classic interview questions one at a time (strengths, a challenge you solved, why this company). ${CORRECTION_POLICY}`,
  },
  {
    id: "lost-in-london",
    sourceLang: "zh",
    targetLang: "en",
    title: "街头问路",
    titleEn: "Lost in London",
    emoji: "🧭",
    difficulty: "A2",
    persona: {
      name: "Ellie",
      role: "friendly London local walking her dog near King's Cross station",
      personality: "easygoing, uses simple directions, adds tiny local tips",
    },
    setting: "你出了地铁站就迷路了，手机也没电了，旁边有一位遛狗的当地人。",
    opener: "Oh hey — you look a bit lost. Do you need a hand?",
    goals: [
      "礼貌开口并说明要去的地点",
      "听懂并复述方向（左转/右转/直走）",
      "地道道谢",
    ],
    targetVocab: [
      "Excuse me, how do I get to ...?",
      "Is it far from here?",
      "go straight / turn left at ...",
      "Cheers! / That's really helpful",
    ],
    systemPrompt: `${COMMON_RULES} You are Ellie, ${PERSONA_DIRECTIONS} Give short step-by-step directions with A2 vocabulary (left, right, straight, two minutes). ${CORRECTION_POLICY}`,
  },
];

export function getScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

export interface ScenarioSummary {
  id: string;
  title: string;
  titleEn: string;
  emoji: string;
  difficulty: Difficulty;
  setting: string;
}

export function listScenarioSummaries(): ScenarioSummary[] {
  return SCENARIOS.map(({ id, title, titleEn, emoji, difficulty, setting }) => ({
    id,
    title,
    titleEn,
    emoji,
    difficulty,
    setting,
  }));
}
