import { describe, expect, it } from "vitest";
import { MockLLMProvider, TaskRouter } from "@sema/ai-core";
import { SIGNUP_GRANT_CENTS } from "@sema/shared";
import { buildApp } from "./app.js";
import { authed, createTestUser, TEST_SMS, TEST_CODE, type TestUser } from "./test-utils.js";

const REVIEW_JSON = JSON.stringify({
  corrections: [
    { original: "I want eat a coffee", corrected: "I would like a coffee", explanation: "want 后面接 to do；coffee 是喝的不是吃的", kind: "grammar" },
  ],
  alternatives: [
    { original: "Give me a coffee", suggestion: "Could I get a coffee, please?", note: "加 could I get 更礼貌自然" },
  ],
  vocab: [
    { term: "oat milk", translation: "燕麦奶", contextSentence: "Could I get a latte with oat milk?" },
    { term: "for here", translation: "堂食", contextSentence: "For here or to go?" },
  ],
  overall: { level: "A2", strengths: "敢开口，基本句型可用", focus: "动词搭配与礼貌句式" },
});

const LECTURE_JSON = JSON.stringify({
  definition: "n. 燕麦奶（植物奶的一种，咖啡店常用）",
  examples: [
    { text: "Could I get a latte with oat milk?", zh: "能给我来杯燕麦奶拿铁吗？" },
    { text: "Oat milk froths really well.", zh: "燕麦奶很好打奶泡。" },
  ],
  nuance: "oat milk 指燕麦奶；soy milk 是豆奶，almond milk 是杏仁奶。咖啡店点单时直接说 oat milk 即可，不用加 latte。",
  memoryHook: "oat（燕麦）+ milk（奶）——画面：一碗燕麦泡出了奶",
  collocations: ["oat milk latte", "barista oat milk", "splash of oat milk"],
});

function mockRouter(): TaskRouter {
  const reviewProvider = new MockLLMProvider("mock-review", () => REVIEW_JSON);
  const dialogueProvider = new MockLLMProvider("mock-flagship", () => "Sure thing — anything else?");
  return new TaskRouter({
    flagship: dialogueProvider,
    cheap: new MockLLMProvider("mock-cheap", () => LECTURE_JSON),
    review: reviewProvider,
  });
}

describe("学习闭环：复盘 → 生词 → 复习 → 档案", () => {
  it("复盘生成→计费→幂等；生词入本；打分调度；档案与导出", async () => {
    const app = await buildApp({ router: mockRouter(), smsSender: TEST_SMS, smsCode: () => TEST_CODE });
    const user = await createTestUser(app);
    await app.inject({ method: "POST", url: `/v1/wallet/grant?userId=${user.userId}`, payload: { cents: SIGNUP_GRANT_CENTS, reason: "测试" } });

    // 1) 跑一段对话并结束
    const started = await app.inject({ method: "POST", url: "/v1/conversations", headers: authed(user.token), payload: { scenarioId: "coffee-order" } });
    const sessionId = (started.json() as { sessionId: string }).sessionId;
    await app.inject({ method: "POST", url: `/v1/conversations/${sessionId}/turns`, headers: authed(user.token), payload: { text: "I want eat a coffee" } });
    await app.inject({ method: "POST", url: `/v1/conversations/${sessionId}/turns`, headers: authed(user.token), payload: { text: "Give me a coffee" } });
    const ended = await app.inject({ method: "POST", url: `/v1/conversations/${sessionId}/end`, headers: authed(user.token) });
    expect(ended.statusCode).toBe(200);

    // 2) 会话没结束时复盘 → 409
    const active = await app.inject({ method: "POST", url: "/v1/conversations", headers: authed(user.token), payload: { scenarioId: "coffee-order" } });
    const activeId = (active.json() as { sessionId: string }).sessionId;
    const early = await app.inject({ method: "POST", url: `/v1/conversations/${activeId}/review`, headers: authed(user.token) });
    expect(early.statusCode).toBe(409);
    await app.inject({ method: "POST", url: `/v1/conversations/${activeId}/end`, headers: authed(user.token) });

    // 3) 生成复盘
    const balanceBefore = await app.inject({ method: "GET", url: "/v1/wallet", headers: authed(user.token) });
    const beforeCents = (balanceBefore.json() as { balanceCredits: number }).balanceCredits;
    const reviewRes = await app.inject({ method: "POST", url: `/v1/conversations/${sessionId}/review`, headers: authed(user.token) });
    expect(reviewRes.statusCode).toBe(200);
    const review = reviewRes.json() as { corrections: unknown[]; vocab: unknown[]; priceCents: number; overall: { level: string } };
    expect(review.corrections).toHaveLength(1);
    expect(review.vocab).toHaveLength(2);
    expect(review.overall.level).toBe("A2");
    expect(review.priceCents).toBe(100);

    // 4) 幂等：重新生成不重复扣费
    const again = await app.inject({ method: "POST", url: `/v1/conversations/${sessionId}/review`, headers: authed(user.token) });
    expect(again.statusCode).toBe(200);
    const balanceAfter = await app.inject({ method: "GET", url: "/v1/wallet", headers: authed(user.token) });
    const delta = beforeCents - (balanceAfter.json() as { balanceCredits: number }).balanceCredits;
    expect(delta).toBe(1); // balanceCredits 单位是积分：复盘 1 积分，只扣一次

    // 5) 生词自动入本（去重）
    const vocabRes = await app.inject({ method: "GET", url: "/v1/vocab", headers: authed(user.token) });
    const vocabList = (vocabRes.json() as { cards: Array<{ term: string; context: string | null }> }).cards;
    expect(vocabList.map((c) => c.term).sort()).toEqual(["for here", "oat milk"]);
    const forHere = vocabList.find((c) => c.term === "for here");
    expect(forHere?.context?.toLowerCase()).toContain("for here or to go");

    const dup = await app.inject({ method: "POST", url: "/v1/conversations", headers: authed(user.token), payload: { scenarioId: "coffee-order" } });
    await app.inject({ method: "POST", url: `/v1/conversations/${(dup.json() as { sessionId: string }).sessionId}/end`, headers: authed(user.token) });
    await app.inject({ method: "POST", url: `/v1/conversations/${(dup.json() as { sessionId: string }).sessionId}/review`, headers: authed(user.token) });
    const vocabAfterDup = await app.inject({ method: "GET", url: "/v1/vocab", headers: authed(user.token) });
    expect((vocabAfterDup.json() as { count: number }).count).toBe(2); // 同词不重复建卡

    // 6) 手动添加 + 到期队列 + 打分
    const manual = await app.inject({ method: "POST", url: "/v1/vocab", headers: authed(user.token), payload: { term: "to go", translation: "带走", context: "For here or to go?" } });
    expect(manual.statusCode).toBe(201);
    const dueRes = await app.inject({ method: "GET", url: "/v1/vocab/due", headers: authed(user.token) });
    const dueCards = (dueRes.json() as { cards: Array<{ id: string; term: string }> }).cards;
    expect(dueCards.length).toBe(3); // 新卡立即可复习

    const graded = await app.inject({ method: "POST", url: `/v1/vocab/${dueCards[0]!.id}/review`, headers: authed(user.token), payload: { grade: 3 } });
    expect(graded.statusCode).toBe(200);
    const gradedCard = graded.json() as { card: { reps: number; dueMs: number; lastReviewMs: number } };
    expect(gradedCard.card.reps).toBe(1);
    expect(gradedCard.card.dueMs).toBeGreaterThan(gradedCard.card.lastReviewMs);

    const dueAfter = await app.inject({ method: "GET", url: "/v1/vocab/due", headers: authed(user.token) });
    expect((dueAfter.json() as { count: number }).count).toBe(2); // 打过分的卡被推后

    const missing = await app.inject({ method: "POST", url: `/v1/vocab/00000000-0000-4000-8000-000000000000/review`, headers: authed(user.token), payload: { grade: 3 } });
    expect(missing.statusCode).toBe(404);

    // 7) 学习档案
    const stats = await app.inject({ method: "GET", url: "/v1/stats", headers: authed(user.token) });
    const profile = stats.json() as { sessions: number; turns: number; totalSeconds: number; vocab: { total: number; dueNow: number; reviewsDone: number }; streakDays: number; activity: unknown[] };
    expect(profile.sessions).toBe(3); // 主会话 + 409 测试用 + 去重测试用
    expect(profile.turns).toBe(2);
    expect(profile.totalSeconds).toBeGreaterThanOrEqual(0);
    expect(profile.vocab.total).toBe(3);
    expect(profile.vocab.reviewsDone).toBe(1);
    expect(profile.activity).toHaveLength(14);
    expect(profile.streakDays).toBeGreaterThanOrEqual(1); // 今天学过

    // 8) 数据导出
    const exported = await app.inject({ method: "GET", url: "/v1/users/me/export", headers: authed(user.token) });
    const dump = exported.json() as { sessions: unknown[]; reviews: unknown[]; vocab: unknown[] };
    expect(dump.sessions).toHaveLength(3);
    expect(dump.reviews).toHaveLength(2);
    expect(dump.vocab).toHaveLength(3);

    await app.close();
  });

  it("生词 AI 精讲：生成计费 0.1 积分，二次命中缓存不再扣费", async () => {
    const app = await buildApp({ router: mockRouter(), smsSender: TEST_SMS, smsCode: () => TEST_CODE });
    const user = await createTestUser(app);
    const stranger = await createTestUser(app);
    await app.inject({ method: "POST", url: `/v1/wallet/grant?userId=${user.userId}`, payload: { cents: SIGNUP_GRANT_CENTS, reason: "测试" } });

    // 走完对话→复盘→生词入本
    const started = await app.inject({ method: "POST", url: "/v1/conversations", headers: authed(user.token), payload: { scenarioId: "coffee-order" } });
    const sessionId = (started.json() as { sessionId: string }).sessionId;
    await app.inject({ method: "POST", url: `/v1/conversations/${sessionId}/turns`, headers: authed(user.token), payload: { text: "Could I get a latte with oat milk?" } });
    await app.inject({ method: "POST", url: `/v1/conversations/${sessionId}/end`, headers: authed(user.token) });
    await app.inject({ method: "POST", url: `/v1/conversations/${sessionId}/review`, headers: authed(user.token) });

    const vocabRes = await app.inject({ method: "GET", url: "/v1/vocab", headers: authed(user.token) });
    const cards = (vocabRes.json() as { cards: Array<{ id: string; term: string }> }).cards;
    expect(cards.length).toBeGreaterThan(0);

    const balanceBefore = await app.inject({ method: "GET", url: "/v1/wallet", headers: authed(user.token) });
    const before = Number((balanceBefore.json() as { balanceCredits: string }).balanceCredits);

    // 首次精讲：生成 + 扣 10厘
    const lectureRes = await app.inject({ method: "POST", url: `/v1/vocab/${cards[0]!.id}/lecture`, headers: authed(user.token), payload: {} });
    expect(lectureRes.statusCode).toBe(200);
    const lecture = lectureRes.json() as { term: string; cached: boolean; chargedCents: number; lecture: { definition: string; examples: unknown[]; nuance: string; memoryHook: string; collocations: string[] } };
    expect(lecture.cached).toBe(false);
    expect(lecture.chargedCents).toBe(10);
    expect(lecture.term).toBe(cards[0]!.term);
    expect(lecture.lecture.examples.length).toBe(2);
    expect(lecture.lecture.collocations).toContain("oat milk latte");

    const balanceMid = await app.inject({ method: "GET", url: "/v1/wallet", headers: authed(user.token) });
    expect(before - Number((balanceMid.json() as { balanceCredits: string }).balanceCredits)).toBeCloseTo(0.1, 5);

    // 二次精讲：缓存命中，零扣费
    const again = await app.inject({ method: "POST", url: `/v1/vocab/${cards[0]!.id}/lecture`, headers: authed(user.token), payload: {} });
    const againBody = again.json() as { cached: boolean; chargedCents: number };
    expect(againBody.cached).toBe(true);
    expect(againBody.chargedCents).toBe(0);
    const balanceAfter = await app.inject({ method: "GET", url: "/v1/wallet", headers: authed(user.token) });
    expect(before - Number((balanceAfter.json() as { balanceCredits: string }).balanceCredits)).toBeCloseTo(0.1, 5);

    // 他人卡片不可精讲
    const strangerRes = await app.inject({ method: "POST", url: `/v1/vocab/${cards[0]!.id}/lecture`, headers: authed(stranger.token), payload: {} });
    expect(strangerRes.statusCode).toBe(404);

    await app.close();
  });
});
