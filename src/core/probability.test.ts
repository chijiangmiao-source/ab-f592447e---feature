import { describe, expect, it } from 'vitest';
import { Decimal } from './decimal';
import {
  parseProbabilityInput,
  quantify,
  QUANT_STATE_BUDGET,
  type EventQuant
} from './probability';

const dec = (s: string): Decimal => parseProbabilityInput(s).value!;

/** 枚举 2^n 世界暴力求并事件概率，作为精确交叉核对。 */
function bruteTop(eventOrder: string[], cutsets: string[][], probs: Record<string, Decimal>): string {
  let total = Decimal.ZERO;
  for (let z = 0; z < 2 ** eventOrder.length; z += 1) {
    let world = Decimal.ONE;
    const failed = new Set<string>();
    eventOrder.forEach((e, i) => {
      const v = ((z >> i) & 1) === 1;
      world = world.mul(v ? probs[e] : Decimal.ONE.sub(probs[e]));
      if (v) failed.add(e);
    });
    if (cutsets.some((cs) => cs.every((e) => failed.has(e)))) total = total.add(world);
  }
  return total.toString();
}

function checkAll(
  eventOrder: string[],
  cutsets: string[][],
  probs: Record<string, Decimal>
): { top: string; events: Record<string, EventQuant> } {
  const q = quantify(eventOrder, cutsets, probs);
  expect(q.status).toBe('ok');
  if (q.status !== 'ok') throw new Error('limit');
  expect(q.topProbability.toString()).toBe(bruteTop(eventOrder, cutsets, probs));
  for (const e of eventOrder) {
    const v = q.events[e];
    // 差值 = P1 − P0
    expect(v.diff.toString()).toBe(v.forcedOccurred.sub(v.forcedAbsent).toString());
    // 单调：P1 >= P0，Δ >= 0
    const scale = Math.max(v.forcedOccurred.scale, v.forcedAbsent.scale);
    const p1 = v.forcedOccurred.coef * 10n ** BigInt(scale - v.forcedOccurred.scale);
    const p0 = v.forcedAbsent.coef * 10n ** BigInt(scale - v.forcedAbsent.scale);
    expect(p1 >= p0).toBe(true);
    // 全概率恒等式：p·P1 + (1−p)·P0 = P(T)，精确相等
    const recon = probs[e].mul(v.forcedOccurred).add(Decimal.ONE.sub(probs[e]).mul(v.forcedAbsent));
    expect(recon.equals(q.topProbability)).toBe(true);
  }
  return { top: q.topProbability.toString(), events: q.events };
}

describe('parseProbabilityInput', () => {
  it('接受 0、1 及至多六位小数', () => {
    for (const s of ['0', '1', '0.0', '1.000000', '0.000001', '0.999999', '.5', '0.123456']) {
      expect(parseProbabilityInput(s).ok, s).toBe(true);
    }
  });

  it('精确归一化末尾零', () => {
    expect(dec('0.50').toString()).toBe('0.5');
    expect(dec('1.000000').toString()).toBe('1');
    expect(dec('0.00').toString()).toBe('0');
  });

  it('拒绝空值', () => {
    expect(parseProbabilityInput('   ').reason).toBe('empty');
  });

  it('拒绝非法格式：符号、指数、多余小数位、非数字', () => {
    for (const s of ['abc', '0.1234567', '1e-3', '0.', '+0.1', '-.5', '0.1.2', ' 0.1 ', '0,1']) {
      // ' 0.1 ' 经过 trim 合法，单独修正
      if (s === ' 0.1 ') {
        expect(parseProbabilityInput(s).ok).toBe(true);
        continue;
      }
      expect(parseProbabilityInput(s).ok, `应拒绝 ${s}`).toBe(false);
      expect(parseProbabilityInput(s).reason).toBe('format');
    }
  });

  it('拒绝越界值', () => {
    for (const s of ['1.000001', '1.5', '2']) {
      const r = parseProbabilityInput(s);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('range');
    }
  });
});

describe('Decimal 精确运算', () => {
  it('加减乘均为精确十进制', () => {
    expect(dec('0.1').add(dec('0.2')).toString()).toBe('0.3');
    expect(dec('1').sub(dec('0.000001')).toString()).toBe('0.999999');
    expect(dec('0.001').mul(dec('0.001')).toString()).toBe('0.000001');
    expect(dec('0.0001').mul(dec('0.0001')).toString()).toBe('0.00000001');
  });
});

describe('顶事件概率（共享/重叠割集不得互斥相加）', () => {
  it('不相交单事件割集：P(A∨B) 精确', () => {
    const r = checkAll(['A', 'B'], [['A'], ['B']], { A: dec('0.25'), B: dec('0.2') });
    expect(r.top).toBe('0.4');
  });

  it('共享事件的割集 {A,B},{A,C}：0.019 而非互斥相加的 0.02', () => {
    const r = checkAll(
      ['A', 'B', 'C'],
      [['A', 'B'], ['A', 'C']],
      { A: dec('0.1'), B: dec('0.1'), C: dec('0.1') }
    );
    expect(r.top).toBe('0.019');
  });

  it('割集 {A,B},{A,C},{B,C} 与暴力枚举一致（三处重叠）', () => {
    const r = checkAll(
      ['A', 'B', 'C'],
      [['A', 'B'], ['A', 'C'], ['B', 'C']],
      { A: dec('0.1'), B: dec('0.2'), C: dec('0.3') }
    );
    // 容斥：0.02+0.03+0.06 − 3·0.006 + 0.006 = 0.098（精确）
    expect(r.top).toBe('0.098');
  });

  it('供电示例 8 个三元割集（共享 LOSS），与 2^7 枚举一致', () => {
    const evs = ['BUS_FAULT', 'MAIN_SRC', 'MAIN_SW', 'BK_SRC', 'BK_SW', 'COMMON_CTRL', 'COSMIC'];
    const cs = [
      ['BK_SRC', 'BUS_FAULT', 'MAIN_SRC'],
      ['BK_SRC', 'BUS_FAULT', 'MAIN_SW'],
      ['BK_SRC', 'COMMON_CTRL', 'MAIN_SRC'],
      ['BK_SRC', 'COMMON_CTRL', 'MAIN_SW'],
      ['BK_SW', 'BUS_FAULT', 'MAIN_SRC'],
      ['BK_SW', 'BUS_FAULT', 'MAIN_SW'],
      ['BK_SW', 'COMMON_CTRL', 'MAIN_SRC'],
      ['BK_SW', 'COMMON_CTRL', 'MAIN_SW']
    ];
    const vals = ['0.1', '0.2', '0.3', '0.4', '0.5', '0.01', '0.7'];
    const probs: Record<string, Decimal> = {};
    evs.forEach((e, i) => (probs[e] = dec(vals[i])));
    const r = checkAll(evs, cs, probs);
    expect(r.top).toBe('0.033572');
  });

  it('无割集（顶事件不可能）=> 0', () => {
    const q = quantify(['A', 'B'], [], { A: dec('0.5'), B: dec('0.5') });
    expect(q.status).toBe('ok');
    if (q.status === 'ok') {
      expect(q.topProbability.toString()).toBe('0');
      expect(q.events.A.forcedOccurred.toString()).toBe('0');
    }
  });
});

describe('强制条件概率', () => {
  it('单事件割集 {A},{B}：强制 A 已发生 => 1；强制 A 未发生 => p(B)', () => {
    const r = checkAll(['A', 'B'], [['A'], ['B']], { A: dec('0.25'), B: dec('0.2') });
    expect(r.events.A.forcedOccurred.toString()).toBe('1');
    expect(r.events.A.forcedAbsent.toString()).toBe('0.2');
    expect(r.events.B.forcedOccurred.toString()).toBe('1');
    expect(r.events.B.forcedAbsent.toString()).toBe('0.25');
  });

  it('{A,B},{A,C}：强制共享事件 A 已发生后族退化为 {B},{C}', () => {
    const r = checkAll(
      ['A', 'B', 'C'],
      [['A', 'B'], ['A', 'C']],
      { A: dec('0.1'), B: dec('0.1'), C: dec('0.1') }
    );
    // P(B∨C)=0.19；强制 A 未发生 => 0
    expect(r.events.A.forcedOccurred.toString()).toBe('0.19');
    expect(r.events.A.forcedAbsent.toString()).toBe('0');
    expect(r.events.A.diff.toString()).toBe('0.19');
    // 强制 B 未发生 => 只剩 {A,C} = 0.01
    expect(r.events.B.forcedAbsent.toString()).toBe('0.01');
  });

  it('概率 0/1 边界仍有确定结果', () => {
    const r = checkAll(['A', 'B'], [['A'], ['B']], { A: dec('1'), B: dec('0') });
    expect(r.top).toBe('1');
    expect(r.events.A.forcedAbsent.toString()).toBe('0');
    expect(r.events.B.forcedOccurred.toString()).toBe('1');
    expect(r.events.B.forcedAbsent.toString()).toBe('1');
    expect(r.events.B.diff.toString()).toBe('0');
  });

  it('无关事件（不在任何割集中）：两种干预都等于原顶事件概率，差值 0', () => {
    const r = checkAll(
      ['A', 'B', 'X'],
      [['A'], ['B']],
      { A: dec('0.25'), B: dec('0.2'), X: dec('0.99') }
    );
    expect(r.events.X.relevant).toBe(false);
    expect(r.events.X.forcedAbsent.toString()).toBe(r.top);
    expect(r.events.X.forcedOccurred.toString()).toBe(r.top);
    expect(r.events.X.diff.isZero).toBe(true);
  });

  it('必现事件（每个割集都含 C）：强制 C 未发生 => 顶事件 0', () => {
    const r = checkAll(
      ['A', 'B', 'C'],
      [['A', 'C'], ['B', 'C']],
      { A: dec('0.3'), B: dec('0.4'), C: dec('0.5') }
    );
    expect(r.events.C.forcedAbsent.toString()).toBe('0');
  });
});

describe('确定性与资源上限', () => {
  it('与事件/割集传入顺序无关：同一模型两种排列结果一致', () => {
    const cs1 = [['A', 'B'], ['A', 'C'], ['B', 'C']];
    const cs2 = [[...cs1[2]], [...cs1[0]], [...cs1[1]]];
    const probs1: Record<string, Decimal> = { A: dec('0.1'), B: dec('0.2'), C: dec('0.3') };
    const q1 = quantify(['A', 'B', 'C'], cs1, probs1);
    const q2 = quantify(['C', 'A', 'B'], cs2, { C: dec('0.3'), A: dec('0.1'), B: dec('0.2') });
    expect(q1.status).toBe('ok');
    expect(q2.status).toBe('ok');
    if (q1.status === 'ok' && q2.status === 'ok') {
      expect(q2.topProbability.toString()).toBe(q1.topProbability.toString());
    }
  });

  it('预算极小时返回 quantitative_limit 且不含任何概率字段', () => {
    const q = quantify(
      ['A', 'B', 'C', 'D'],
      [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D']],
      { A: dec('0.5'), B: dec('0.5'), C: dec('0.5'), D: dec('0.5') },
      1
    );
    expect(q.status).toBe('quantitative_limit');
    expect('topProbability' in q).toBe(false);
    if (q.status === 'quantitative_limit') expect(q.budget).toBe(1);
  });

  it('超上限后放宽预算（模拟输入修正）立即恢复完整结果', () => {
    const probs: Record<string, Decimal> = {};
    const evs = ['A', 'B', 'C', 'D'];
    evs.forEach((e) => (probs[e] = dec('0.5')));
    const cs = [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D']];
    expect(quantify(evs, cs, probs, 1).status).toBe('quantitative_limit');
    const recovered = quantify(evs, cs, probs);
    expect(recovered.status).toBe('ok');
  });

  it('默认上限为常量且可容纳常见规模', () => {
    expect(QUANT_STATE_BUDGET).toBeGreaterThan(1000);
  });
});
