/**
 * verify 一次性服务的规定场景断言（由 esbuild 打包为 Node ESM 后执行）。
 * 覆盖：
 *   1. 吸收律场景的最小割集；
 *   2. 共享子门的事件归属；
 *   3. 任一门规范化后超过 2000 个割集的超限场景；
 *   4. 定量复核：重叠割集精确并事件概率、强制条件概率与恒等式、0/1 边界；
 *   5. 定量资源上限 quantitative_limit：保留定性割集、不出部分概率、修正即恢复。
 * 任一断言失败即以非零退出码结束进程。
 */
import { analyze } from '../src/core/engine';
import { Decimal } from '../src/core/decimal';
import { audit } from '../src/core/pipeline';
import { parseProbabilityInput, quantify } from '../src/core/probability';
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

// ---- 场景 4：定量复核（精确十进制，重叠割集不互斥相加） ----
console.log('[scenario 4] quantitative review: exact union, interventions, identity');
{
  const dec = (s: string): Decimal => parseProbabilityInput(s).value!;

  // 4a. 重叠割集 {A,B},{A,C}：共享 A，P=0.1·0.1 + 0.1·0.1 − 0.1·0.1·0.1 = 0.019
  //     （错误地互斥相加会得到 0.02，必须不同）。
  {
    const evs = ['A', 'B', 'C'];
    const cs = [['A', 'B'], ['A', 'C']];
    const probs = { A: dec('0.1'), B: dec('0.1'), C: dec('0.1') };
    const q = quantify(evs, cs, probs);
    check('重叠割集状态为 ok', q.status === 'ok', q);
    if (q.status === 'ok') {
      check('顶事件概率精确为 0.019（非互斥相加的 0.02）', q.topProbability.toString() === '0.019', q.topProbability.toString());
      // 强制 A=1 后割集退化为 {B},{C} => 0.19；A=0 => 0；差值 0.19
      check('强制 A 已发生 => 0.19', q.events.A.forcedOccurred.toString() === '0.19', q.events.A);
      check('强制 A 未发生 => 0', q.events.A.forcedAbsent.toString() === '0', q.events.A);
      check('差值为 0.19', q.events.A.diff.toString() === '0.19', q.events.A.diff.toString());
      // 全概率恒等式对每个事件成立
      for (const e of evs) {
        const v = q.events[e];
        const recon = probs[e].mul(v.forcedOccurred).add(Decimal.ONE.sub(probs[e]).mul(v.forcedAbsent));
        check(`全概率恒等式对 ${e} 精确成立`, recon.equals(q.topProbability), `${recon} vs ${q.topProbability}`);
      }
    }
  }

  // 4b. 概率 0/1 边界：{A},{B}, p(A)=1, p(B)=0 => P(T)=1，干预确定。
  {
    const q = quantify(['A', 'B'], [['A'], ['B']], { A: dec('1'), B: dec('0') });
    check('0/1 边界状态 ok', q.status === 'ok', q);
    if (q.status === 'ok') {
      check('P(T)=1', q.topProbability.toString() === '1');
      check('强制 A 未发生 => 0', q.events.A.forcedAbsent.toString() === '0');
      check('强制 B 已发生 => 1', q.events.B.forcedOccurred.toString() === '1');
      check('B 的差值为 0', q.events.B.diff.isZero);
    }
  }

  // 4c. 旧格式兼容：无概率信息的定性模型，audit 仍为 complete 且割集正确；
  //     概率校验把空字符串归为 empty（只阻止定量，不改动定性）。
  {
    const r = audit('A\nB\n', 'TOP OR A B\n', 'TOP');
    check('旧的仅标识输入定性完整', r.status === 'complete', r.status);
    check('空概率归为 empty 且非法文本 reason 正确',
      parseProbabilityInput('').reason === 'empty' &&
      parseProbabilityInput('0.1234567').reason === 'format' &&
      parseProbabilityInput('1.000001').reason === 'range');
  }
}

// ---- 场景 5：quantitative_limit（保留定性、不出部分概率、修正即恢复） ----
console.log('[scenario 5] quantitative_limit: keep qualitative, no partial, recover on fix');
{
  // 30 事件 / 80 门：79 个随机三元 AND 门经一个 OR 顶门合并（固定 LCG 种子，可复现）。
  let seed = 42;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const triples: number[][] = [];
  const seen = new Set<string>();
  while (triples.length < 79) {
    const a = Math.floor(rand() * 30);
    let b = Math.floor(rand() * 30);
    while (b === a) b = Math.floor(rand() * 30);
    let c = Math.floor(rand() * 30);
    while (c === a || c === b) c = Math.floor(rand() * 30);
    const t = [a, b, c].sort((x, y) => x - y);
    const key = t.join(',');
    if (!seen.has(key)) {
      seen.add(key);
      triples.push(t);
    }
  }
  const evs = Array.from({ length: 30 }, (_, i) => `E${i}`);
  const gateNames = triples.map((_, i) => `G${String(i).padStart(2, '0')}`);
  const lines = triples.map((t, i) => `${gateNames[i]} AND E${t[0]} E${t[1]} E${t[2]}`);
  lines.push(`TOP OR ${gateNames.join(' ')}`);
  const r = analyze(buildModel(evs, lines, 'TOP'));
  check('难模型定性完整（79 个割集）', r.status === 'complete' && r.cutsets.length === 79, r.status);

  if (r.status === 'complete') {
    const probs: Record<string, Decimal> = {};
    evs.forEach((e) => (probs[e] = parseProbabilityInput('0.5').value!));
    const q = quantify(evs, r.cutsets, probs);
    check('定量超过确定性上限', q.status === 'quantitative_limit', q.status);
    if (q.status === 'quantitative_limit') {
      check('limit 结果不含任何概率字段', !('topProbability' in q) && !('events' in q), q);
      // 修正（同一概率下简化为单割集）立即恢复
      const recovered = quantify(evs, [r.cutsets[0]], probs);
      check('输入修正后完整结果立即恢复（0.125）',
        recovered.status === 'ok' && recovered.topProbability.toString() === '0.125', recovered.status);
    }
  }
}

if (failures > 0) {
  console.error(`\nVERIFY SCENARIOS FAILED: ${failures}`);
  process.exit(1);
}
console.log('\nALL VERIFY SCENARIOS PASSED');
