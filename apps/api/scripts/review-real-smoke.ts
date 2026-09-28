/**
 * 真实学习闭环冒烟：真 LLM 对话 → 真复盘报告（结构化解析）
 * 运行：npx tsx scripts/review-real-smoke.ts
 */
import type { AddressInfo } from "node:net";
import { loadEnvFiles } from "../src/env.js";
import { buildApp } from "../src/app.js";

async function main(): Promise<void> {
  loadEnvFiles();
  const app = await buildApp();
  await app.inject({ method: "POST", url: "/v1/wallet/smoke/grant", payload: { cents: 50000, reason: "复盘冒烟" } });

  const started = await app.inject({ method: "POST", url: "/v1/conversations", payload: { userId: "smoke", scenarioId: "coffee-order" } });
  const sessionId = (started.json() as { sessionId: string }).sessionId;
  console.log("开场白:", ((started.json() as { opener: string }).opener).slice(0, 60));

  for (const line of ["Hi Ben, I want a coffee please", "Sorry, I mean I would like a latte with oat milk"]) {
    const turn = await app.inject({ method: "POST", url: `/v1/conversations/${sessionId}/turns`, payload: { text: line } });
    const body = turn.json() as { reply?: string; error?: unknown };
    if (body.reply) console.log(`你: ${line}\nBen: ${body.reply.slice(0, 80)}`);
    else console.log(`turn 失败(${turn.statusCode}):`, turn.body.slice(0, 160));
  }
  await app.inject({ method: "POST", url: `/v1/conversations/${sessionId}/end` });

  const reviewRes = await app.inject({ method: "POST", url: `/v1/conversations/${sessionId}/review` });
  if (reviewRes.statusCode !== 200) {
    console.error(`❌ 复盘失败(${reviewRes.statusCode}):`, reviewRes.body.slice(0, 400));
    process.exit(1);
  }
  const review = reviewRes.json() as {
    corrections: Array<{ original: string; corrected: string; explanation: string }>;
    alternatives: Array<{ suggestion: string; note: string }>;
    vocab: Array<{ term: string; translation: string }>;
    overall: { level: string; strengths: string; focus: string };
    vocabIngested: { added: number; duplicates: number };
  };
  console.log(`\n📋 复盘报告（${review.overall.level}）`);
  for (const c of review.corrections) console.log(`  纠错: ${c.original} → ${c.corrected}（${c.explanation.slice(0, 40)}）`);
  for (const a of review.alternatives) console.log(`  地道: ${a.suggestion}（${a.note.slice(0, 40)}）`);
  for (const v of review.vocab) console.log(`  生词: ${v.term} = ${v.translation}`);
  console.log(`  亮点: ${review.overall.strengths.slice(0, 60)}\n  重点: ${review.overall.focus.slice(0, 60)}`);
  console.log(`生词入本: +${review.vocabIngested.added}（重复 ${review.vocabIngested.duplicates}）`);

  const due = await app.inject({ method: "GET", url: "/v1/vocab/due?userId=smoke" });
  const dueCards = (due.json() as { cards: Array<{ id: string; term: string }> }).cards;
  console.log("到期复习队列:", dueCards.map((c) => c.term).join(", "));

  // 生词 AI 精讲（廉价档真模型，10厘/词，每词一次）
  if (dueCards.length > 0) {
    const lectureRes = await app.inject({ method: "POST", url: `/v1/vocab/${dueCards[0]!.id}/lecture`, payload: { userId: "smoke" } });
    if (lectureRes.statusCode !== 200) {
      console.error(`❌ 精讲失败(${lectureRes.statusCode}):`, lectureRes.body.slice(0, 300));
      process.exit(1);
    }
    const lec = lectureRes.json() as { term: string; cached: boolean; chargedCents: number; lecture: { definition: string; examples: Array<{ en: string }>; nuance: string; memoryHook: string; collocations: string[] } };
    console.log(`\n📖 精讲「${lec.term}」（${lec.cached ? "缓存" : `新生成, ${lec.chargedCents}厘`}）`);
    console.log(`  释义: ${lec.lecture.definition}`);
    console.log(`  例句: ${lec.lecture.examples.map((e) => e.en).join(" / ")}`);
    console.log(`  辨析: ${lec.lecture.nuance.slice(0, 70)}`);
    console.log(`  钩子: ${lec.lecture.memoryHook.slice(0, 70)}`);
    console.log(`  搭配: ${lec.lecture.collocations.join(", ")}`);
  }

  const stats = await app.inject({ method: "GET", url: "/v1/stats/smoke" });
  const profile = stats.json() as { turns: number; vocab: { total: number } };
  console.log(`档案: 开口 ${profile.turns} 次, 生词 ${profile.vocab.total} 个`);

  // 纠错允许为空——说得没错就不该编造错误；生词与总评必须存在
  const ok = review.vocab.length > 0 && review.overall.level.length > 0;
  console.log(ok ? "✅ 真实学习闭环冒烟通过" : "❌ 报告结构不完整");
  app.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e: unknown) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });
