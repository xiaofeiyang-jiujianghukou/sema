/**
 * 生词即点即译：结合对话语境的词义查询（LLM 一次调用）。
 * 与生词本解耦——查词只翻译；入库走 /v1/vocab（vocabBook.add，去重 + SRS）。
 */
import type { TaskRouter } from "@sema/ai-core";
import type { TargetLang } from "../../content/scenarios.js";

export interface WordLookup {
  word: string;
  translation: string;
  pos: string | null;
  note: string | null;
}

const LANG_NAME: Record<TargetLang, string> = { en: "英语", ja: "日语", ko: "韩语" };

export async function lookupWord(
  router: TaskRouter,
  word: string,
  context: string | undefined,
  lang: TargetLang,
): Promise<WordLookup> {
  const decision = router.route("dialogue");
  const system = [
    `你是${LANG_NAME[lang]}学习助教。解释词语在语境中的含义，帮助中文学习者理解。`,
    '只返回 JSON，不要 markdown 代码块：{"translation":"中文释义（结合语境，简明）","pos":"词性或短语类型","note":"一句中文用法/搭配说明"}',
  ].join("\n");
  const user = context ? `词语：${word}\n语境：${context}` : `词语：${word}`;

  const result = decision.provider.chat({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    maxTokens: 200,
  });
  let raw = "";
  for await (const chunk of result.chunks) raw += chunk;

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { translation?: unknown; pos?: unknown; note?: unknown };
      const translation = String(parsed.translation ?? "").trim();
      if (translation.length > 0) {
        return {
          word,
          translation: translation.slice(0, 200),
          pos: parsed.pos ? String(parsed.pos).slice(0, 20) : null,
          note: parsed.note ? String(parsed.note).slice(0, 200) : null,
        };
      }
    } catch {
      // 落到原文兜底
    }
  }
  return { word, translation: raw.trim().slice(0, 200) || "（查询失败，请重试）", pos: null, note: null };
}
