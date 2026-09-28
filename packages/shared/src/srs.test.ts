import { describe, expect, it } from "vitest";
import { newSrsState, scheduleSrs, type SrsState } from "./srs.js";

const NOW = Date.UTC(2026, 0, 1, 8, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function reviewed(prev: SrsState, grade: 1 | 2 | 3 | 4, atMs: number): SrsState {
  return scheduleSrs(prev, grade, atMs);
}

describe("FSRS-5 调度", () => {
  it("新卡状态：new，到期即当前时刻", () => {
    const card = newSrsState(NOW);
    expect(card.state).toBe("new");
    expect(card.dueMs).toBe(NOW);
    expect(card.reps).toBe(0);
    expect(card.lapses).toBe(0);
  });

  it("确定性：同一输入永远同一输出", () => {
    const card = newSrsState(NOW);
    const a = scheduleSrs(card, 3, NOW);
    const b = scheduleSrs(card, 3, NOW);
    expect(a).toEqual(b);
  });

  it("首次打分进入复习态，稳定性按等级递增", () => {
    const again = reviewed(newSrsState(NOW), 1, NOW);
    const hard = reviewed(newSrsState(NOW), 2, NOW);
    const good = reviewed(newSrsState(NOW), 3, NOW);
    const easy = reviewed(newSrsState(NOW), 4, NOW);
    expect(again.stability).toBeLessThan(hard.stability);
    expect(hard.stability).toBeLessThan(good.stability);
    expect(good.stability).toBeLessThan(easy.stability);
    for (const card of [again, hard, good, easy]) {
      expect(card.reps).toBe(1);
      expect(card.state).toBe("review"); // 无短期步：首打即入天级复习
      expect(card.dueMs).toBeGreaterThan(card.lastReviewMs!);
    }
  });

  it("复习链路：稳定性单调增长，间隔越来越长", () => {
    let card = reviewed(newSrsState(NOW), 3, NOW);
    card = reviewed(card, 3, card.dueMs); // 到期时打 good
    const afterTwo = card.stability;
    expect(card.state).toBe("review");
    const gapDays = (card.dueMs - card.lastReviewMs!) / DAY;
    expect(gapDays).toBeGreaterThan(0.5); // 第二次 good 已进入天级间隔

    card = reviewed(card, 3, card.dueMs);
    expect(card.stability).toBeGreaterThan(afterTwo);
    expect((card.dueMs - card.lastReviewMs!) / DAY).toBeGreaterThan(gapDays);
  });

  it("遗忘：lapses+1，稳定性回落，进入重学态", () => {
    let card = reviewed(newSrsState(NOW), 3, NOW);
    card = reviewed(card, 3, card.dueMs);
    const stableBefore = card.stability;
    const lapsesBefore = card.lapses;

    const forgotten = reviewed(card, 1, card.dueMs);
    expect(forgotten.lapses).toBe(lapsesBefore + 1);
    expect(forgotten.stability).toBeLessThan(stableBefore);
    expect(forgotten.state).toBe("review"); // 无重学步：遗忘后直接重排复习间隔
  });

  it("难度始终夹在 [1,10]", () => {
    let card = newSrsState(NOW);
    for (let i = 0; i < 12; i += 1) {
      card = reviewed(card, 1, card.dueMs); // 连续「忘了」——难度应封顶
      expect(card.difficulty).toBeLessThanOrEqual(10);
      expect(card.difficulty).toBeGreaterThanOrEqual(1);
    }
    card = newSrsState(NOW);
    for (let i = 0; i < 12; i += 1) {
      card = reviewed(card, 4, card.dueMs); // 连续「轻松」——难度应探底
      expect(card.difficulty).toBeGreaterThanOrEqual(1);
    }
  });

  it("到期前打分（提前复习）不产生负间隔", () => {
    let card = reviewed(newSrsState(NOW), 3, NOW);
    card = reviewed(card, 3, card.dueMs);
    const early = reviewed(card, 3, card.lastReviewMs! + DAY); // 提前很多
    expect(early.dueMs).toBeGreaterThan(early.lastReviewMs!);
  });

  it("轻卡 vs 难卡：同样打 good，难卡下间隔更短", () => {
    const fresh = newSrsState(NOW);
    // 一路「轻松」的卡
    let easyCard = reviewed(fresh, 4, NOW);
    // 一路「费劲」的卡
    let hardCard = reviewed(newSrsState(NOW), 2, NOW);
    for (let i = 0; i < 3; i += 1) {
      easyCard = reviewed(easyCard, 3, easyCard.dueMs);
      hardCard = reviewed(hardCard, 3, hardCard.dueMs);
    }
    const easyGap = (easyCard.dueMs - easyCard.lastReviewMs!) / DAY;
    const hardGap = (hardCard.dueMs - hardCard.lastReviewMs!) / DAY;
    expect(easyGap).toBeGreaterThan(hardGap);
  });
});
