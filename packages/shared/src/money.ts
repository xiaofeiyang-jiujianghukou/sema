/**
 * 言泉 · 积分货币数学
 *
 * 核心原则：积分内部一律用整数「厘」（credit-cent）计算，
 * 1 积分 = 100 厘。绝不用浮点数参与计费，杜绝 0.1 + 0.2 !== 0.3 类事故。
 */
export const CENTS_PER_CREDIT = 100;
/** ¥1 = 10 积分（定价锚点，上线前校准） */
export const CREDITS_PER_CNY = 10;
export const CENTS_PER_CNY = CENTS_PER_CREDIT * CREDITS_PER_CNY; // 1000 厘 = ¥1

/** 积分金额（单位：厘），恒为非负整数 */
export type CreditCents = number;

export function assertCents(cents: number): void {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`积分金额必须是 非0负整数（厘），收到: ${cents}`);
  }
}

/**
 * 对话计费：按秒向上取整到厘。
 */
export function conversationCents(seconds: number, centsPerSecond: number): CreditCents {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`对话秒数不合法: ${seconds}`);
  }
  return Math.ceil(seconds * centsPerSecond);
}

/** 厘 → 积分显示文本：3000 → "30"，3050 → "30.5"，5 → "0.05" */
export function formatCredits(cents: CreditCents): string {
  assertCents(cents);
  const credits = cents / CENTS_PER_CREDIT;
  if (Number.isInteger(credits)) return `${credits}`;
  return credits.toFixed(2).replace(/0$/, "");
}

/** 厘 → 人民币参考价文本（内部成本核算用）：1000 → "¥1.00" */
export function formatYuanRef(cents: CreditCents): string {
  assertCents(cents);
  return `¥${(cents / CENTS_PER_CNY).toFixed(2)}`;
}
