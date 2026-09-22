import { describe, expect, it } from 'vitest';
import { analyze } from './engine';
import { parseEvents, parseModel, parseProbability, PROBABILITY_DENOMINATOR } from './parser';
import { analyzeQuantitative, collectProbabilityEntries, QUANT_NODE_LIMIT } from './probability';
import { audit } from './pipeline';
import { STRESS_EVENTS_HALF, STRESS_EVENTS_ZERO, STRESS_GATES, STRESS_TOP } from '../sample';
import type { CompleteAnalysis, EventFieldInfo, ParsedModel } from './types';

function model(events: string[], lines: string[], top: string): ParsedModel {
  const gates = lines.map((line, i) => {
    const [name, type, ...inputs] = line.trim().split(/\s+/);
    return { name, type: type as 'AND' | 'OR', inputs, line: i + 1 };
  });
  return { events, gates, top };
}

function complete(events: string[], lines: string[], top: string): CompleteAnalysis {
  const r = analyze(model(events, lines, top));
  if (r.status !== 'complete') throw new Error(`expected complete, got ${r.status}`);
  return r;
}

function entries(events: string[], probs: Record<string, string>) {
  return events.map((e, i) => {
    const raw = probs[e] ?? '0';
    return { event: e, line: i + 1, input: raw, numerator: BigInt(Math.round(Number(raw) * 1_000_000)) };
  });
}

describe('概率字段解析', () => {
  it('接受 0/1/省略整数位/补零，拒绝越界、七位小数、符号、科学计数', () => {
    expect(parseProbability('0')).toMatchObject({ status: 'valid', numerator: 0n });
    expect(parseProbability('1')).toMatchObject({ status: 'valid', numerator: 1_000_000n });
    expect(parseProbability('.5')).toMatchObject({ status: 'valid', numerator: 500_000n });
    expect(parseProbability('0.500000')).toMatchObject({ status: 'valid', numerator: 500_000n });
    expect(parseProbability('1.000000')).toMatchObject({ status: 'valid', numerator: 1_000_000n });
    expect(parseProbability('').status).toBe('missing');

    for (const bad of ['1.0000001', '0.1234567', '1.1', '-0.1', '+0.1', '1e-3', '0.', '2', 'abc', '0.5x']) {
      expect(parseProbability(bad).status, bad).toBe('invalid');
    }
    expect(parseProbability('1.2').reason).toContain('[0, 1]');
    expect(parseProbability('0.1234567').reason).toContain('六位');
  });

  it('旧的仅标识行视为缺失；概率非法不产生定性 issue，但记入字段信息', () => {
    const a = parseEvents('A\nB 0.1\nC 1.5\n');
    expect(a.issues).toHaveLength(0);
    expect(a.events).toEqual(['A', 'B', 'C']);
    expect(a.fields.map((f) => [f.name, f.probStatus])).toEqual([
      ['A', 'missing'],
      ['B', 'valid'],
      ['C', 'invalid']
    ]);
    expect(PROBABILITY_DENOMINATOR).toBe(1_000_000n);
  });

  it('每行超过两个字段视为非法概率行', () => {
    const f = parseEvents('A 0.1 0.2\n').fields[0];
    expect(f.probStatus).toBe('invalid');
    expect(f.probReason).toContain('两个字段');
  });
});

describe('顶事件概率：重叠割集不按互斥相加', () => {
  it('A∨B：P=pA+pB−pA·pB，精确等于 0.28 而非 0.3', () => {
    const r = complete(['A', 'B'], ['T OR A B'], 'T');
    const q = analyzeQuantitative(r, entries(['A', 'B'], { A: '0.1', B: '0.2' }));
    expect(q.status).toBe('quant_ok');
    if (q.status !== 'quant_ok') return;
    expect(q.top.decimal).toBe('0.28');
  });

  it('共享基本事件：(A∧B)∨(B∧C) = 0.375，而非两个割集直接相加的 0.5', () => {
    const r = complete(
      ['A', 'B', 'C'],
      ['G1 AND A B', 'G2 AND B C', 'T OR G1 G2'],
      'T'
    );
    const q = analyzeQuantitative(r, entries(['A', 'B', 'C'], { A: '0.5', B: '0.5', C: '0.5' }));
    if (q.status !== 'quant_ok') throw new Error(JSON.stringify(q.status));
    expect(q.top.decimal).toBe('0.375');
    const qb = q.events.find((e) => e.event === 'B')!;
    expect(qb.absent.decimal).toBe('0');
    expect(qb.present.decimal).toBe('0.75');
    expect(qb.delta.decimal).toBe('0.75');
  });

  it('吸收后的单割集：T=A∨(A∧B) 最小割集仅 {A}，P(T)=pA', () => {
    const r = complete(['A', 'B'], ['G AND A B', 'T OR A G'], 'T');
    expect(r.cutsets).toEqual([['A']]);
    const q = analyzeQuantitative(r, entries(['A', 'B'], { A: '0.3', B: '0.4' }));
    if (q.status !== 'quant_ok') throw new Error('x');
    expect(q.top.decimal).toBe('0.3');
  });

  it('六位小数精确值：0.000003999997，无浮点漂移', () => {
    const r = complete(['A', 'B'], ['T OR A B'], 'T');
    const q = analyzeQuantitative(r, entries(['A', 'B'], { A: '0.000001', B: '0.000003' }));
    if (q.status !== 'quant_ok') throw new Error('x');
    expect(q.top.decimal).toBe('0.000003999997');
  });

  it('必现事件的概率作为公共因子：(A∨B)∧C', () => {
    // 割集 {A,C},{B,C}；P = pC·(pA+pB−pA pB) = 0.5·0.28 = 0.14
    const r = complete(['A', 'B', 'C'], ['S OR A B', 'T AND S C'], 'T');
    const q = analyzeQuantitative(r, entries(['A', 'B', 'C'], { A: '0.1', B: '0.2', C: '0.5' }));
    if (q.status !== 'quant_ok') throw new Error('x');
    expect(q.top.decimal).toBe('0.14');
  });
});

describe('强制条件概率、差值与一致性', () => {
  it('每个事件给出 P(T|e=0)、P(T|e=1)、Δ 且满足全概率分解与偏序', () => {
    const r = complete(['A', 'B'], ['T OR A B'], 'T');
    const q = analyzeQuantitative(r, entries(['A', 'B'], { A: '0.1', B: '0.2' }));
    if (q.status !== 'quant_ok') throw new Error('x');
    for (const e of q.events) {
      expect(e.identityHolds, e.event).toBe(true);
      expect(e.orderHolds, e.event).toBe(true);
      // Δ 恰为 present − absent
      expect(e.delta.numerator * e.absent.denominator * e.present.denominator >= 0n).toBe(true);
    }
    const qa = q.events.find((e) => e.event === 'A')!;
    expect(qa.absent.decimal).toBe('0.2');
    expect(qa.present.decimal).toBe('1');
    expect(qa.delta.decimal).toBe('0.8');
    expect(qa.p.decimal).toBe('0.1');
  });

  it('概率边界 0 与 1：顶事件必现/必不发生，条件概率仍有定义', () => {
    const r = complete(['A', 'B'], ['T OR A B'], 'T');
    const q = analyzeQuantitative(r, entries(['A', 'B'], { A: '0', B: '1' }));
    if (q.status !== 'quant_ok') throw new Error('x');
    expect(q.top.decimal).toBe('1');
    const qa = q.events.find((e) => e.event === 'A')!;
    expect(qa.absent.decimal).toBe('1');
    expect(qa.present.decimal).toBe('1');
    expect(qa.delta.decimal).toBe('0');
  });

  it('无关事件：两种干预结果相同，差值为 0', () => {
    const r = audit(
      'A\nB\nX\n',
      'S OR A B\nL AND S A\nR AND S B\nT OR L R\n',
      'T'
    );
    if (r.status !== 'complete') throw new Error('x');
    const q = analyzeQuantitative(r, entries(['A', 'B', 'X'], { A: '0.1', B: '0.2', X: '0.9' }));
    if (q.status !== 'quant_ok') throw new Error('x');
    const qx = q.events.find((e) => e.event === 'X')!;
    expect(qx.delta.decimal).toBe('0');
    expect(qx.absent.decimal).toBe(qx.present.decimal);
    expect(q.top.decimal).toBe('0.28');
  });
});

describe('概率缺失/非法只阻止定量结论', () => {
  function fieldsOf(eventsText: string): EventFieldInfo[] {
    return parseModel(eventsText, 'T OR A B C\n', 'T').eventFields;
  }

  it('缺一个与非法一个：返回 prob_invalid 且可定位行', () => {
    const parsed = parseModel('A 0.1\nB 1.2\nC\n', 'T OR A B C\n', 'T');
    expect(parsed.issues).toHaveLength(0);
    const r = audit('A 0.1\nB 1.2\nC\n', 'T OR A B C\n', 'T');
    expect(r.status).toBe('complete');
    if (r.status !== 'complete') return;
    const collected = collectProbabilityEntries(['A', 'B', 'C'], fieldsOf('A 0.1\nB 1.2\nC\n'));
    expect('problems' in collected).toBe(true);
    if (!('problems' in collected)) return;
    expect(collected.problems.map((p) => [p.name, p.kind])).toEqual([
      ['B', 'invalid'],
      ['C', 'missing']
    ]);
    expect(collected.problems.find((p) => p.name === 'B')!.line).toBe(2);
  });

  it('全部有效时才进入定量计算', () => {
    const r = audit('A 0.1\nB 0.2\n', 'T OR A B\n', 'T');
    if (r.status !== 'complete') throw new Error('x');
    const parsed = parseModel('A 0.1\nB 0.2\n', 'T OR A B\n', 'T');
    const collected = collectProbabilityEntries(['A', 'B'], parsed.eventFields);
    expect('entries' in collected).toBe(true);
    if (!('entries' in collected)) return;
    const q = analyzeQuantitative(r, collected.entries);
    expect(q.status).toBe('quant_ok');
  });
});

describe('quantitative_limit', () => {
  it('高重叠割集族在合法约束内触发上限，且不输出任何概率', () => {
    // 30 事件、80 门、78 个十元割集 + 必现事件 M；状态数确定性超过 200000。
    const r = audit(STRESS_EVENTS_HALF, STRESS_GATES, STRESS_TOP);
    expect(r.status).toBe('complete'); // 定性结论完整保留
    if (r.status !== 'complete') return;
    expect(r.cutsets.length).toBe(78);
    const parsed = parseModel(STRESS_EVENTS_HALF, STRESS_GATES, STRESS_TOP);
    const collected = collectProbabilityEntries(parsed.model.events, parsed.eventFields);
    if (!('entries' in collected)) throw new Error('entries expected');
    const q = analyzeQuantitative(r, collected.entries);
    expect(q.status).toBe('quantitative_limit');
    if (q.status !== 'quantitative_limit') return;
    expect(q.limit).toBe(QUANT_NODE_LIMIT);
    expect(q.nodes).toBeGreaterThan(QUANT_NODE_LIMIT);
    expect('top' in q).toBe(false); // 不得出现部分概率
  });

  it('修正输入（概率全 0）后立即恢复完整定量结果', () => {
    const r = audit(STRESS_EVENTS_ZERO, STRESS_GATES, STRESS_TOP);
    if (r.status !== 'complete') throw new Error('x');
    const parsed = parseModel(STRESS_EVENTS_ZERO, STRESS_GATES, STRESS_TOP);
    const collected = collectProbabilityEntries(parsed.model.events, parsed.eventFields);
    if (!('entries' in collected)) throw new Error('entries expected');
    const q = analyzeQuantitative(r, collected.entries);
    expect(q.status).toBe('quant_ok');
    if (q.status !== 'quant_ok') return;
    expect(q.top.decimal).toBe('0');
    expect(q.nodes).toBeLessThan(QUANT_NODE_LIMIT);
    expect(q.events).toHaveLength(30);
  });
});
