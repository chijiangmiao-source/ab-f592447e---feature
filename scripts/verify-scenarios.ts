/**
 * verify 一次性服务的规定场景断言（由 esbuild 打包为 Node ESM 后执行）。
 * 覆盖：
 *   1. 吸收律场景的最小割集；
 *   2. 共享子门的事件归属；
 *   3. 任一门规范化后超过 2000 个割集的超限场景。
 * 任一断言失败即以非零退出码结束进程。
 */
import { analyze } from '../src/core/engine';
import { audit } from '../src/core/pipeline';
import { parseModel } from '../src/core/parser';
import { analyzeQuantitative, collectProbabilityEntries, QUANT_NODE_LIMIT } from '../src/core/probability';
import { STRESS_EVENTS_HALF, STRESS_EVENTS_ZERO, STRESS_GATES, STRESS_TOP } from '../src/sample';
import type { ParsedModel } from '../src/core/types';

let failures = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}`, detail ?? '');
  }
}

function buildModel(events: string[], lines: string[], top: string): ParsedModel {
  const gates = lines.map((line, i) => {
    const [name, type, ...inputs] = line.trim().split(/\s+/);
    return { name, type: type as 'AND' | 'OR', inputs, line: i + 1 };
  });
  return { events, gates, top };
}

const names = (cuts: string[][]): string[] => cuts.map((c) => [...c].sort().join('*'));

// ---- 场景 1：吸收律 ----
// TOP = G1 OR G2，G1=A OR B，G2=A AND B；{A,B} 是 {A}、{B} 的真超集，必须被吸收。
console.log('[scenario 1] absorption: A∨B∨(A∧B) => {A},{B}');
{
  const r = audit('A\nB\n', 'G1 OR A B\nG2 AND A B\nTOP OR G1 G2\n', 'TOP');
  check('状态为 complete', r.status === 'complete', r);
  if (r.status === 'complete') {
    check('最小割集恰为 {A},{B}', JSON.stringify(names(r.cutsets)) === JSON.stringify(['A', 'B']), names(r.cutsets));
  }
}

// ---- 场景 2：共享子门的事件归属 ----
// S 被 L、R 共享；T=(S∧A)∨(S∧B)。割集 {A},{B}，X 未接入任何门。
console.log('[scenario 2] shared sub-gate classification');
{
  const r = analyze(
    buildModel(
      ['A', 'B', 'X'],
      ['S OR A B', 'L AND S A', 'R AND S B', 'T OR L R'],
      'T'
    )
  );
  check('状态为 complete', r.status === 'complete', r);
  if (r.status === 'complete') {
    check('A=可选', r.classification.A === 'optional', r.classification);
    check('B=可选', r.classification.B === 'optional', r.classification);
    check('X=无关', r.classification.X === 'irrelevant', r.classification);
    check('割集为 {A},{B}', JSON.stringify(names(r.cutsets)) === JSON.stringify(['A', 'B']), names(r.cutsets));
    check('共享门 S 仅规范化一次（计数=2）', r.gateCounts.S === 2, r.gateCounts);
  }
}

// ---- 场景 3：complexity_limit ----
// 7 个三选一组相与 => 3^7 = 2187 > 2000；必须报告 complexity_limit 且不得产出完整结论。
console.log('[scenario 3] complexity_limit at 3^7=2187 > 2000');
{
  const events: string[] = [];
  const lines: string[] = [];
  for (let g = 0; g < 7; g += 1) {
    const members = [`e${g}_0`, `e${g}_1`, `e${g}_2`];
    events.push(...members);
    lines.push(`GRP${g} OR ${members.join(' ')}`);
  }
  lines.push('BIG AND GRP0 GRP1 GRP2 GRP3 GRP4 GRP5 GRP6');
  const r = analyze(buildModel(events, lines, 'BIG'));
  check('状态为 complexity_limit', r.status === 'complexity_limit', r);
  if (r.status === 'complexity_limit') {
    check('定位到超限门 BIG', r.gate === 'BIG', r);
    check('上限为 2000', r.limit === 2000, r);
    check('未输出任何割集（不冒充完整结论）', !('cutsets' in r), r);
  }
  // 边界：恰好 2000（4*5*10*10）必须完整
  const sizes = [4, 5, 10, 10];
  const ev2: string[] = [];
  const ln2: string[] = [];
  sizes.forEach((s, gi) => {
    const members = Array.from({ length: s }, (_, k) => `h${gi}_${k}`);
    ev2.push(...members);
    ln2.push(`GRP${gi} OR ${members.join(' ')}`);
  });
  ln2.push('BIG AND GRP0 GRP1 GRP2 GRP3');
  const r2 = analyze(buildModel(ev2, ln2, 'BIG'));
  check('恰好 2000 时完整输出 2000 个割集', r2.status === 'complete' && r2.cutsets.length === 2000, r2.status);
}

// ---- 场景 4：定量复核（独立失效概率，精确有理算术） ----
function entriesFrom(eventsText: string, gatesText: string, top: string) {
  const parsed = parseModel(eventsText, gatesText, top);
  const collected = collectProbabilityEntries(parsed.model.events, parsed.eventFields);
  return { parsed, collected };
}

console.log('[scenario 4] quantitative review: overlapping cutsets, exact arithmetic');
{
  // (A∧B)∨(B∧C)：割集共享 B，直接相加得 0.5，正确值 0.25+0.25−0.125=0.375。
  const r = audit('A 0.5\nB 0.5\nC 0.5\n', 'G1 AND A B\nG2 AND B C\nT OR G1 G2\n', 'T');
  check('含概率输入状态仍为 complete', r.status === 'complete', r.status);
  if (r.status === 'complete') {
    const { collected } = entriesFrom('A 0.5\nB 0.5\nC 0.5\n', 'G1 AND A B\nG2 AND B C\nT OR G1 G2\n', 'T');
    if ('problems' in collected) {
      check('概率全部有效', false, collected.problems);
    } else {
      const q = analyzeQuantitative(r, collected.entries);
      check('定量计算成功', q.status === 'quant_ok', q.status);
      if (q.status === 'quant_ok') {
        check('重叠割集顶事件概率精确为 0.375（不是互斥相加的 0.5）', q.top.decimal === '0.375', q.top.decimal);
        const qb = q.events.find((e) => e.event === 'B')!;
        check('共享事件 B：强制未发生=0、已发生=0.75、差值=0.75',
          qb.absent.decimal === '0' && qb.present.decimal === '0.75' && qb.delta.decimal === '0.75',
          { a: qb.absent.decimal, p: qb.present.decimal, d: qb.delta.decimal });
        check('每个事件满足全概率分解与偏序 P0≤P(T)≤P1',
          q.events.every((e) => e.identityHolds && e.orderHolds));
      }
    }
  }
}

console.log('[scenario 5] legacy identifier-only input + invalid probability is non-blocking');
{
  // 旧格式：仅标识，无概率字段——定性完整，定量 prob_invalid。
  const r1 = audit('A\nB\n', 'T OR A B\n', 'T');
  check('旧格式定性 complete', r1.status === 'complete', r1.status);
  const c1 = entriesFrom('A\nB\n', 'T OR A B\n', 'T');
  check('旧格式定量被阻止（2 个缺失）',
    'problems' in c1.collected && c1.collected.problems.length === 2 &&
      c1.collected.problems.every((p) => p.kind === 'missing'),
    'problems' in c1.collected ? c1.collected.problems : 'ok');

  // 非法概率（越界、七位小数）不进 issues，但阻止定量；定性割集仍完整。
  const r2 = audit('A 1.1\nB 0.1234567\n', 'T OR A B\n', 'T');
  check('非法概率不阻断定性 complete', r2.status === 'complete', r2.status);
  const c2 = entriesFrom('A 1.1\nB 0.1234567\n', 'T OR A B\n', 'T');
  check('非法概率阻止定量（2 个 invalid）',
    'problems' in c2.collected && c2.collected.problems.length === 2 &&
      c2.collected.problems.every((p) => p.kind === 'invalid'),
    'problems' in c2.collected ? c2.collected.problems : 'ok');

  // 六位小数精度：A=0.000001, B=0.000003 => 精确 0.000003999997
  const r3 = audit('A 0.000001\nB 0.000003\n', 'T OR A B\n', 'T');
  if (r3.status === 'complete') {
    const c3 = entriesFrom('A 0.000001\nB 0.000003\n', 'T OR A B\n', 'T');
    if ('entries' in c3.collected) {
      const q = analyzeQuantitative(r3, c3.collected.entries);
      check('六位小数输入精确计算无浮点漂移', q.status === 'quant_ok' && q.top.decimal === '0.000003999997',
        q.status === 'quant_ok' ? q.top.decimal : q.status);
    }
  }
}

console.log('[scenario 6] probability boundaries 0 and 1');
{
  const r = audit('A 0\nB 1\n', 'T OR A B\n', 'T');
  check('边界输入定性 complete', r.status === 'complete', r.status);
  if (r.status === 'complete') {
    const c = entriesFrom('A 0\nB 1\n', 'T OR A B\n', 'T');
    if ('entries' in c.collected) {
      const q = analyzeQuantitative(r, c.collected.entries);
      check('pA=0,pB=1 时顶事件概率精确为 1', q.status === 'quant_ok' && q.top.decimal === '1',
        q.status === 'quant_ok' ? q.top.decimal : q.status);
      if (q.status === 'quant_ok') {
        const qa = q.events.find((e) => e.event === 'A')!;
        check('边界事件条件概率仍有定义且差值为 0',
          qa.absent.decimal === '1' && qa.present.decimal === '1' && qa.delta.decimal === '0');
        check('一致性全部成立', q.events.every((e) => e.identityHolds && e.orderHolds));
      }
    }
  }
}

console.log('[scenario 7] quantitative_limit keeps cutsets and recovers on input fix');
{
  const r = audit(STRESS_EVENTS_HALF, STRESS_GATES, STRESS_TOP);
  check('压力模型定性 complete 且割集保留（78 个）', r.status === 'complete' && r.cutsets.length === 78, r.status);
  if (r.status === 'complete') {
    const c = entriesFrom(STRESS_EVENTS_HALF, STRESS_GATES, STRESS_TOP);
    if ('entries' in c.collected) {
      const q = analyzeQuantitative(r, c.collected.entries);
      check('超出确定性资源上限 => quantitative_limit',
        q.status === 'quantitative_limit' && q.limit === QUANT_NODE_LIMIT, q.status);
      check('限态不携带任何概率结论', q.status === 'quantitative_limit' && !('top' in q), q.status);
    }
  }
  // 输入修正（全部概率改为 0）后立即恢复完整结果。
  const r0 = audit(STRESS_EVENTS_ZERO, STRESS_GATES, STRESS_TOP);
  if (r0.status === 'complete') {
    const c0 = entriesFrom(STRESS_EVENTS_ZERO, STRESS_GATES, STRESS_TOP);
    if ('entries' in c0.collected) {
      const q0 = analyzeQuantitative(r0, c0.collected.entries);
      check('概率全 0 后定量立即恢复，顶事件概率精确为 0',
        q0.status === 'quant_ok' && q0.top.decimal === '0' && q0.events.length === 30,
        q0.status);
    }
  }
}

if (failures > 0) {
  console.error(`\nVERIFY SCENARIOS FAILED: ${failures}`);
  process.exit(1);
}
console.log('\nALL VERIFY SCENARIOS PASSED');
