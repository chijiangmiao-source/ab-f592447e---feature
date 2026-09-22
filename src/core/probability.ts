// 独立失效概率分析（定量复核）。
//
// 关键语义：多个最小割集会共享基本事件，顶事件概率是“至少一个割集全部发生”
// 的并事件概率，绝不能把各割集概率直接相加（那会把重叠组合重复计算，
// 等于错误地假设割集两两互斥）。这里对事件做香农展开（不交分解）并记忆化：
//
//   F(族; 已赋值) = p_e · F(族/e=1) + (1−p_e) · F(族/e=0)
//
//   e=1：每个割集删去 e（C={e,a,b} 退化为 a∧b；{e} 退化为空割集 => 顶事件发生）；
//   e=0：所有含 e 的割集不可能发生，直接删去。
//
// 展开天然不交、精确处理共享割集，全部运算为 bigint 十进制（仅加减乘），
// 结果是与输入等精度的精确有限小数。
//
// 条件概率采用“干预（强制）”定义：把某事件强制为未发生/已发生后，
// 对割集族做相应删简（强制已发生时移除该事件位并重新吸收化简），
// 再计算顶事件概率。该定义在原概率为 0/1 的边界上仍有确定结果，
// 且满足全概率恒等式 P(T) = p·P(T‖X=1) + (1−p)·P(T‖X=0)。

import { Decimal } from './decimal';

/**
 * 确定性资源上限：整个定量复核（顶事件 + 每个事件的两次强制）共享同一份
 * 记忆化，累计产生的“剩余割集族”状态数不得超过该预算。超过即
 * quantitative_limit：不输出任何概率数字（包括顶事件概率），定性割集照常保留。
 */
export const QUANT_STATE_BUDGET = 50_000;

export type ProbabilityReason = 'empty' | 'format' | 'range';

export interface ProbabilityParse {
  ok: boolean;
  value?: Decimal;
  reason?: ProbabilityReason;
}

// 接受：0 / 1 / 整数 / 0.xxxxxx / 1.000000 / .xxxxx；至多六位小数。
// 数值越界（如 2、1.5、1.000001）在解析后归类为 range；其余非法写法归类为 format。
const PROB_RE = /^(?:\d(?:\.\d{1,6})?|\.\d{1,6})$/;

/**
 * 按用户输入的十进制文本精确解析为 [0,1] 上的 Decimal。
 * 不接受 1.000001 等越界值，也不接受科学计数法（避免隐式浮点语义）。
 */
export function parseProbabilityInput(raw: string): ProbabilityParse {
  const text = raw.trim();
  if (text === '') return { ok: false, reason: 'empty' };
  if (!PROB_RE.test(text)) return { ok: false, reason: 'format' };

  const dot = text.indexOf('.');
  const intPart = dot < 0 ? text : text.slice(0, dot);
  const frac = dot < 0 ? '' : text.slice(dot + 1);
  const unit = 10n ** BigInt(frac.length);
  const coef = BigInt(`${intPart}${frac}`);
  if (coef > unit) return { ok: false, reason: 'range' };
  // 整数部分为 1 时，小数部分必须全为零（即值恰为 1）。
  if (intPart === '1' && coef !== unit) return { ok: false, reason: 'range' };
  return { ok: true, value: Decimal.fromCoef(coef, frac.length) };
}

export interface EventQuant {
  /** 原概率（用户输入的精确十进制） */
  probability: Decimal;
  /** 强制该事件未发生后的顶事件概率 P(T‖X=0) */
  forcedAbsent: Decimal;
  /** 强制该事件已发生后的顶事件概率 P(T‖X=1) */
  forcedOccurred: Decimal;
  /** 差值 P(T‖X=1) − P(T‖X=0)，单调故障树下恒非负 */
  diff: Decimal;
  /** 是否出现在顶事件某个最小割集中（无关事件的干预不改变顶事件） */
  relevant: boolean;
}

export interface QuantitativeOk {
  status: 'ok';
  topProbability: Decimal;
  events: Record<string, EventQuant>;
}

export interface QuantitativeLimit {
  status: 'quantitative_limit';
  budget: number;
}

export type QuantOutcome = QuantitativeOk | QuantitativeLimit;

class BudgetExceeded extends Error {}

type Mask = number;

function bitCountOf(m: Mask): number {
  let n = 0;
  let x = m;
  while (x) {
    n += 1;
    x &= x - 1;
  }
  return n;
}

/** 对位掩码族去重并按吸收律保极小（与引擎同一语义的独立小实现）。 */
function absorb(family: Mask[]): Mask[] {
  const buckets: Mask[][] = Array.from({ length: 31 }, () => []);
  const seen = new Set<Mask>();
  for (const m of family) {
    if (!seen.has(m)) {
      seen.add(m);
      buckets[bitCountOf(m)].push(m);
    }
  }
  const kept: Mask[] = [];
  for (let size = 0; size <= 30; size += 1) {
    for (const m of buckets[size]) {
      let absorbed = false;
      for (const k of kept) {
        if ((m & k) === k) {
          absorbed = true;
          break;
        }
      }
      if (!absorbed) kept.push(m);
    }
  }
  return kept;
}

/**
 * 香农展开求 P(∪ 割集)。所有待求族（原族与各事件强制后的删简族）共享同一
 * 记忆化：键就是剩余割集族本身，故状态数与资源消耗完全确定、可复现。
 *
 * 枢轴序在根族上一次性确定（出现于越多割集的事件越早展开，并列取低位），
 * 各分支沿用同一全局序：这使各强制条件族的计算尽可能落入主展开已产生的状态。
 */
function createSolver(probs: Decimal[], budget: { used: number; limit: number }, root: Mask[]) {
  const memo = new Map<string, Decimal>();
  const bitIndex = new Map<Mask, number>();
  for (let i = 0; i < probs.length; i += 1) bitIndex.set(1 << i, i);

  const freq = new Map<Mask, number>();
  for (const m of root) {
    let x = m;
    while (x) {
      const b = x & -x;
      freq.set(b, (freq.get(b) ?? 0) + 1);
      x ^= b;
    }
  }
  const globalOrder = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([b]) => b);

  const solve = (family: Mask[]): Decimal => {
    if (family.length === 0) return Decimal.ZERO;
    // 空割集 => 某条割集的全部事件已被赋真 => 顶事件必然发生。
    if (family.includes(0)) return Decimal.ONE;

    const key = family.length === 1 ? `${family[0]}` : family.slice().sort((a, b) => a - b).join(',');
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    budget.used += 1;
    if (budget.used > budget.limit) throw new BudgetExceeded();

    // 全局序中第一个仍出现于当前族的事件（频次/并列规则固定，结果可复现）。
    const pivot = globalOrder.find((b) => family.some((m) => m & b))!;

    // e=1：每个割集删去 e 位后重新吸收（含 {e} 时会出现空割集 => 1）。
    const occurredFamily = absorb(family.map((m) => m & ~pivot));
    // e=0：删去所有含 e 的割集（剩余族仍为极小反链，无需再化简）。
    const absentFamily = family.filter((m) => !(m & pivot));

    const branchOccurred = solve(occurredFamily);
    const branchAbsent = solve(absentFamily);

    const p = probs[bitIndex.get(pivot)!];
    const result = p.mul(branchOccurred).add(Decimal.ONE.sub(p).mul(branchAbsent));
    memo.set(key, result);
    return result;
  };

  return solve;
}

/**
 * 计算顶事件概率及每个事件强制未发生 / 已发生后的条件概率与差值。
 * 任一计算越过确定性预算都返回 quantitative_limit（不输出任何部分概率）。
 *
 * @param eventOrder 事件标识顺序（与 masks 的位序一致）
 * @param cutsets 顶事件最小割集（字符串数组）
 * @param probabilities 每个事件的精确概率
 */
export function quantify(
  eventOrder: string[],
  cutsets: string[][],
  probabilities: Record<string, Decimal>,
  budgetLimit: number = QUANT_STATE_BUDGET
): QuantOutcome {
  const bitOf = new Map<string, number>();
  eventOrder.forEach((e, i) => bitOf.set(e, i));
  const probs = eventOrder.map((e) => probabilities[e]);
  const masks = cutsets.map((cs) => cs.reduce<Mask>((acc, e) => acc | (1 << bitOf.get(e)!), 0));

  let usedMask: Mask = 0;
  for (const m of masks) usedMask |= m;

  const budget = { used: 0, limit: budgetLimit };
  const solve = createSolver(probs, budget, masks);

  try {
    const topProbability = solve(masks);

    const events: Record<string, EventQuant> = {};
    eventOrder.forEach((e, i) => {
      const bit = 1 << i;
      const relevant = (usedMask & bit) !== 0;
      const p = probs[i];

      // 强制未发生：删去所有含该事件的割集。
      const forcedAbsent = solve(masks.filter((m) => !(m & bit)));

      // 强制已发生：移除该事件位并重新吸收化简。
      let forcedOccurred: Decimal;
      if (!relevant) {
        forcedOccurred = topProbability;
      } else if (masks.includes(bit)) {
        // 该事件本身构成单事件割集 => 顶事件必然发生。
        forcedOccurred = Decimal.ONE;
      } else {
        forcedOccurred = solve(absorb(masks.map((m) => m & ~bit)));
      }

      // 单调故障树：强制发生的概率不小于强制不发生。
      if (forcedOccurred.coef * 10n ** BigInt(forcedAbsent.scale) <
          forcedAbsent.coef * 10n ** BigInt(forcedOccurred.scale)) {
        throw new Error(`quantify: non-monotone result at ${e}`);
      }

      events[e] = {
        probability: p,
        forcedAbsent,
        forcedOccurred,
        diff: forcedOccurred.sub(forcedAbsent),
        relevant
      };
    });

    return { status: 'ok', topProbability, events };
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      return { status: 'quantitative_limit', budget: budget.limit };
    }
    throw err;
  }
}
