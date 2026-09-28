/**
 * 生词 AI 精讲——复习时按需触发
 *
 * 一个词只生成一次（缓存终身、幂等计费 `lecture:cardId`，vocab_lecture 10厘/词），
 * 内容：释义、地道例句、近义辨析、记忆钩子、常见搭配。走廉价档模型
 * （router.route("vocab")），生成失败的词不会被扣费（先生成后计费）。
 */
import { z } from "zod";
import { PRICING } from "@sema/shared";
import type { TaskRouter } from "@sema/ai-core";
import type { WalletService } from "../wallet/service.js";
import { VocabCardNotFoundError, type VocabLecture, type VocabRepo } from "./service.js";

export class LectureParseError extends Error {
  readonly code = "LECTURE_PARSE_ERROR";
  constructor(detail: string) {
    super(`精讲输出解析失败: ${detail}`);
  }
}

const lectureSchema = z.object({
  definition: z.string().min(1).max(300),
  examples: z.array(z.object({
    en: z.string().min(1).max(300),
    zh: z.string().min(1).max(300),
  })).min(2).max(4),
  nuance: z.string().min(1).max(600),
  memoryHook: z.string().min(1).max(600),
  collocations: z.array(z.string().min(1).max(120)).min(1).max(5),
});

const LECTURE_PROMPT = `You are a vocabulary coach for Chinese learners of English.
Given a word/phrase and its context, reply with ONLY a JSON object (no markdown, no code fence):
{
  "definition": "中文释义，含词性，如 n. 燕麦奶",
  "examples": [{"en": "natural English sentence", "zh": "中文翻译"}],
  "nuance": "与近义词/易混表达的区别，中文，具体到使用场景",
  "memoryHook": "记忆钩子：词根词缀/发音联想/场景画面，中文",
  "collocations": ["常见搭配1", "常见搭配2"]
}
Rules: examples 2-3 条且必须自然地道；nuance 说清"什么时候用这个词而不是那个词"；memoryHook 一句话但要有效。`;

export interface LectureDeps {
  repo: VocabRepo;
  wallets: WalletService;
  router: TaskRouter;
}

export interface LectureResult {
  term: string;
  lecture: VocabLecture;
  /** true = 命中缓存，未扣费 */
  cached: boolean;
  chargedCents: number;
}

export class LectureService {
  constructor(private readonly deps: LectureDeps) {}

  async generate(userId: string, cardId: string): Promise<LectureResult> {
    const card = await this.deps.repo.get(cardId);
    if (!card || card.userId !== userId) throw new VocabCardNotFoundError(cardId);
    if (card.lecture) {
      return { term: card.term, lecture: card.lecture, cached: true, chargedCents: 0 };
    }

    const decision = this.deps.router.route("vocab");
    const result = decision.provider.chat({
      messages: [
        { role: "system", content: LECTURE_PROMPT },
        {
          role: "user",
          content: `Word/phrase: ${card.term}\nMeaning hint: ${card.translation}\nContext where the learner met it: ${card.context ?? "(none)"}`,
        },
      ],
      temperature: 0.3,
      maxTokens: 900,
    });
    let raw = "";
    for await (const chunk of result.chunks) raw += chunk;

    const lecture = this.parse(raw);

    // 先生成成功再计费：解析失败不扣钱
    await this.deps.wallets.charge(userId, "vocab_lecture", 1, {
      idempotencyKey: `lecture:${cardId}`,
      reason: `生词精讲 ${card.term}`,
    });
    await this.deps.repo.save({ ...card, lecture });

    return { term: card.term, lecture, cached: false, chargedCents: PRICING.vocab_lecture.centsPerUnit };
  }

  private parse(raw: string): VocabLecture {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new LectureParseError("响应中找不到 JSON 对象");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch (err) {
      throw new LectureParseError(`JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    const checked = lectureSchema.safeParse(parsed);
    if (!checked.success) {
      throw new LectureParseError(checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    return checked.data;
  }
}
