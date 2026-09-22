// 独立失效概率定量复核 —— 全部使用 BigInt 精确有理算术。
//
// 顶事件的最小割集之间普遍共享基本事件（割集重叠），既不穷尽也不互斥：
// 直接相加各割集概率会重复计算交集。这里把顶事件视为单调布尔函数
// “各割集（合取）之析取”，在基本事件相互独立的假设下用 Shannon 展开
//
//   F(上下文) = (1−p_i)·F(…, e_i=0) + p_i·F(…, e_i=1)
//
// 递归求值：任一割集被“已发生”集合包含即为 1；含“未发生”事件的割集
// 死亡，全部死亡即为 0。输入概率只有至多六位小数（n/10^6），
// 归约后的分母只含因子 2、5，因此每个结果都有**有限且精确**的十进制表示。
//
// 所有 61 个查询（1 个原概率 + 每事件 2 个强制条件）共享同一记忆化表，
// 相同的 (未发生集, 已发生集) 状态只计算一次。

import { PROBABILITY_DENOMINATOR } from './parser';
import type {
  CompleteAnalysis,
  EventQuantitative,
  ProbValue,
  ProbabilityProblem,
  QuantitativeResult
} from './types';

/**
 * 确定性资源上限：整个定量复核（全部查询合计）允许计算的不同状态数。
 * 超过即返回 quantitative_limit：不输出任何部分概率，定性割集仍然保留。
 * 上限固定（不依赖运行时、不随机），同一输入永远得到同一结论。
 */
export const QUANT_NODE_LIMIT = 200_000;

const ZERO: ProbValue = { numerator: 0n, denominator: 1n, decimal: '0' };
const ONE: ProbValue = { numerator: 1n, denominator: 1n, decimal: '1' };

function bgcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b;
  while (y) {
    [x, y] = [y, x % y];
  }
  return x;
}

/**
 * 生成分母只含因子 2、5 的有理值的精确有限十进制展开。
 * 六位小数输入的任意加/乘/条件组合，归约后分母仍为 2^a·5^b（a,b ≤ 180），
 * 故十进制必然终止，不引入任何浮点舍入。
 */
function toDecimal(n: bigint, d: bigint): string {
  if (n === 0n) return '0';
  if (n === d) return '1';
  const digits: string[] = [];
  let rem = n;
  // 终止性由输入分母保证；硬上限仅作防御，超出说明输入不变量被破坏。
  for (let guard = 0; rem !== 0n && guard < 1000; guard += 1) {
    rem *= 10n;
    digits.push(String(rem / d));
    rem %= d;
  }
  return `0.${digits.join('')}`;
}

function mkProb(n: bigint, d: bigint): ProbValue {
  if (n === 0n) return ZERO;
  const g = bgcd(n, d);
  const numerator = n / g;
  const denominator = d / g;
  if (numerator === denominator) return ONE;
  return { numerator, denominator, decimal: toDecimal(numerator, denominator) };
}

/** (1−p)·x + p·y：权重取自概率自身的（可能已约分的）分子分母。 */
function weighted(p: ProbValue, x: ProbValue, y: ProbValue): ProbValue {
  if (x === y) return x;
  const pn = p.numerator;
  const pd = p.denominator;
  const n = (pd - pn) * x.numerator * y.denominator + pn * y.numerator * x.denominator;
  const d = pd * x.denominator * y.denominator;
  return mkProb(n, d);
}

function subtract(a: ProbValue, b: ProbValue): ProbValue {
  return mkProb(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator);
}

/** 精确交叉相乘比较：a ≤ b。 */
function leq(a: ProbValue, b: ProbValue): boolean {
  return a.numerator * b.denominator <= b.numerator * a.denominator;
}

function eq(a: ProbValue, b: ProbValue): boolean {
  return a.numerator * b.denominator === b.numerator * a.denominator;
}

export interface ProbabilityEntry {
  event: string;
  line: number;
  /** 用户输入原文 */
  input: string;
  /** 已校验为 [0,1] 内六位小数的概率分子（分母 10^6） */
  numerator: bigint;
}

class BudgetExceeded {
  constructor(readonly nodes: number) {}
}

/**
 * 定量复核入口。
 * @param analysis 完整定性结论（complete 状态）
 * @param entries  每个基本事件一行的有效概率（调用方先行校验齐全性）
 */
export function analyzeQuantitative(
  analysis: CompleteAnalysis,
  entries: ProbabilityEntry[]
): QuantitativeResult {
  const events = entries.map((e) => e.event);
  const bitOf = new Map<string, number>();
  events.forEach((e, i) => bitOf.set(e, i));
  const n = events.length;
  const probs = new Map<number, ProbValue>();
  entries.forEach((e, i) => probs.set(i, mkProb(e.numerator, PROBABILITY_DENOMINATOR)));

  const cutsetMasks: number[] = analysis.cutsets.map((cs) =>
    cs.reduce((acc, name) => acc | (1 << bitOf.get(name)!), 0)
  );

  const memo = new Map<string, ProbValue>();
  let nodes = 0;

  // 状态 = （被强制未发生事件位掩码，被强制已发生事件位掩码），二者不相交。
  const evaluate = (absent: number, present: number): ProbValue => {
    const key = `${absent.toString(36)}|${present.toString(36)}`;
    const cached = memo.get(key);
    if (cached) return cached;
    nodes += 1;
    if (nodes > QUANT_NODE_LIMIT) throw new BudgetExceeded(nodes);

    let anySurvivor = false;
    const counts = new Array<number>(n).fill(0);
    let needUnion = 0;

    for (const m of cutsetMasks) {
      if (m & absent) continue; // 该割集含被强制未发生的事件，已死亡
      const need = m & ~present;
      if (need === 0) {
        // 某割集的全部事件均已发生（或被强制发生），顶事件必现。
        memo.set(key, ONE);
        return ONE;
      }
      anySurvivor = true;
      needUnion |= need;
      let bits = need;
      while (bits) {
        const b = 31 - Math.clz32(bits & -bits);
        counts[b] += 1;
        bits &= bits - 1;
      }
    }

    if (!anySurvivor) {
      memo.set(key, ZERO);
      return ZERO;
    }

    // 确定性的变量次序：在存活割集所需变量中，选择出现次数最多者，
    // 并数以最低位优先打破平局——尽早产生 0/1 剪枝，且结果可复现。
    let chosen = -1;
    let best = -1;
    let bits = needUnion;
    while (bits) {
      const low = bits & -bits;
      const b = 31 - Math.clz32(low);
      if (counts[b] > best) {
        best = counts[b];
        chosen = b;
      }
      bits ^= low;
    }

    // 确定性边界剪枝：零权重分支不产生贡献，无需递归（也不计入资源）。
    const p = probs.get(chosen)!;
    if (p.numerator === 0n) {
      const v0only = evaluate(absent | (1 << chosen), present);
      memo.set(key, v0only);
      return v0only;
    }
    if (p.numerator === p.denominator) {
      const v1only = evaluate(absent, present | (1 << chosen));
      memo.set(key, v1only);
      return v1only;
    }
    const v0 = evaluate(absent | (1 << chosen), present);
    const v1 = evaluate(absent, present | (1 << chosen));
    const result = weighted(p, v0, v1);
    memo.set(key, result);
    return result;
  };

  let top: ProbValue;
  try {
    top = evaluate(0, 0);
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      return { status: 'quantitative_limit', limit: QUANT_NODE_LIMIT, nodes: err.nodes };
    }
    throw err;
  }

  const out: EventQuantitative[] = [];
  for (let i = 0; i < n; i += 1) {
    const entry = entries[i];
    const p = probs.get(i)!;
    let absent: ProbValue;
    let present: ProbValue;
    try {
      absent = evaluate(1 << i, 0);
      present = evaluate(0, 1 << i);
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        return { status: 'quantitative_limit', limit: QUANT_NODE_LIMIT, nodes: err.nodes };
      }
      throw err;
    }
    const delta = subtract(present, absent);

    // 精确核对全概率分解：P(T) = (1−p)·P(T|e=0) + p·P(T|e=1)
    const reconstructed = weighted(p, absent, present);
    const identityHolds = eq(top, reconstructed);
    // 精确偏序：强制已发生只会提高（或不动）顶事件概率。
    const orderHolds = leq(absent, top) && leq(top, present);

    out.push({ event: entry.event, line: entry.line, input: entry.input, p, absent, present, delta, identityHolds, orderHolds });
  }

  return { status: 'quant_ok', top, events: out, nodes };
}

/**
 * 由事件字段信息汇集定量复核所需的概率输入。
 * 任一基本事件概率缺失或非法时返回 prob_invalid（仅阻止定量结论）。
 */
export function collectProbabilityEntries(
  eventNames: string[],
  fields: {
    line: number;
    name: string;
    nameValid: boolean;
    probRaw: string;
    probStatus: 'missing' | 'valid' | 'invalid';
    probReason?: string;
    probNumerator?: bigint;
  }[]
): { entries: ProbabilityEntry[] } | { problems: ProbabilityProblem[] } {
  const byName = new Map(fields.filter((f) => f.nameValid).map((f) => [f.name, f]));
  const entries: ProbabilityEntry[] = [];
  const problems: ProbabilityProblem[] = [];

  for (const name of eventNames) {
    const f = byName.get(name);
    if (!f || f.probStatus === 'missing') {
      problems.push({ line: f?.line ?? 0, name, raw: f?.probRaw ?? '', kind: 'missing' });
      continue;
    }
    if (f.probStatus === 'invalid' || f.probNumerator === undefined) {
      problems.push({ line: f.line, name, raw: f.probRaw, kind: 'invalid', reason: f.probReason });
      continue;
    }
    entries.push({ event: name, line: f.line, input: f.probRaw, numerator: f.probNumerator });
  }

  return problems.length > 0 ? { problems } : { entries };
}
