import { useEffect, useMemo, useRef, useState } from 'react';
import { auditDetailed } from './core/pipeline';
import { analyzeQuantitative, collectProbabilityEntries } from './core/probability';
import type {
  CompleteAnalysis,
  EventFieldInfo,
  EventQuantitative,
  EventRole,
  Issue,
  ProbabilityProblem,
  QuantitativeResult
} from './core/types';
import { SAMPLE_EVENTS, SAMPLE_EVENTS_WITH_PROB, SAMPLE_GATES, SAMPLE_TOP, STRESS_EVENTS_HALF, STRESS_EVENTS_ZERO, STRESS_GATES, STRESS_TOP } from './sample';

type AreaKey = 'events' | 'gates' | 'top';
type AnalysisResult = ReturnType<typeof auditDetailed>['analysis'];

interface EditorRefs {
  events: React.RefObject<HTMLTextAreaElement>;
  gates: React.RefObject<HTMLTextAreaElement>;
  top: React.RefObject<HTMLInputElement>;
}

const ROLE_LABEL: Record<EventRole, string> = {
  mandatory: '必现',
  optional: '可选',
  irrelevant: '无关'
};

const ROLE_HINT: Record<EventRole, string> = {
  mandatory: '出现在顶事件的每一个最小割集中（顶事件发生的必要贡献者）',
  optional: '出现在部分最小割集中',
  irrelevant: '不出现在任何最小割集中（对顶事件无贡献）'
};

export function App(): JSX.Element {
  const [eventsText, setEventsText] = useState(SAMPLE_EVENTS);
  const [gatesText, setGatesText] = useState(SAMPLE_GATES);
  const [topText, setTopText] = useState(SAMPLE_TOP);

  const eventsRef = useRef<HTMLTextAreaElement>(null);
  const gatesRef = useRef<HTMLTextAreaElement>(null);
  const topRef = useRef<HTMLInputElement>(null);
  const refs: EditorRefs = { events: eventsRef, gates: gatesRef, top: topRef };

  const { analysis, eventFields } = useMemo(
    () => auditDetailed(eventsText, gatesText, topText),
    [eventsText, gatesText, topText]
  );
  const result: AnalysisResult = analysis;

  // 概率缺失/非法行：仅提示，不阻止定性分析。
  const probWarnLines = useMemo(() => {
    const set = new Set<number>();
    if (result.status === 'complete') {
      for (const f of eventFields) {
        if (f.nameValid && f.probStatus !== 'valid') set.add(f.line);
      }
    }
    return set;
  }, [result, eventFields]);

  const issueLines = useMemo(() => {
    const map: Record<AreaKey, Set<number>> = { events: new Set(), gates: new Set(), top: new Set() };
    if (result.status === 'invalid') {
      for (const issue of result.issues) {
        if (issue.location.line !== undefined) map[issue.location.area as AreaKey].add(issue.location.line);
      }
    }
    return map;
  }, [result]);

  const locateLine = (area: AreaKey, line?: number): void => {
    const target = refs[area].current;
    if (!target) return;
    target.focus();
    if (area === 'top' || line === undefined) {
      (target as HTMLInputElement).select?.();
      return;
    }
    const textarea = target as HTMLTextAreaElement;
    const lines = textarea.value.split(/\r?\n/);
    let start = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i += 1) {
      start += lines[i].length + 1;
    }
    const end = start + (lines[line - 1]?.length ?? 0);
    textarea.setSelectionRange(start, end);
    // 估算滚动位置（约 18px/行）并将问题行置于可视区上部
    const approxLineHeight = 18;
    textarea.scrollTop = Math.max(0, (line - 3) * approxLineHeight);
  };

  const locate = (issue: Issue): void => locateLine(issue.location.area as AreaKey, issue.location.line);

  const eventCount = eventsText.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length;
  const gateCount = gatesText.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length;

  return (
    <div className="page">
      <header className="topbar">
        <h1>航天器供电故障树 · 最小割集审计</h1>
        <p className="subtitle">
          全部计算在浏览器本地完成 · 无业务后端、无在线调用 · 共享有向无环图精确展开 ·
          单门规范化割集上限 2000 · 定量复核使用 BigInt 精确有理算术
        </p>
      </header>

      <div className="layout">
        <section className="editors">
          <EditorPanel
            title="基本事件"
            counter={`${eventCount} 个（允许 2–30）；每行：标识 [概率]，概率可选，0–1 且至多六位小数`}
            errorLines={issueLines.events}
            warnLines={probWarnLines}
          >
            <textarea
              ref={eventsRef}
              value={eventsText}
              spellCheck={false}
              onChange={(e) => setEventsText(e.target.value)}
              aria-label="基本事件编辑区，每行一个 ASCII 标识，可选第二字段填写独立失效概率"
            />
          </EditorPanel>

          <EditorPanel
            title="门定义"
            counter={`${gateCount} 个（允许 1–80），语法：名称 AND|OR 输入...`}
            errorLines={issueLines.gates}
            warnLines={new Set()}
          >
            <textarea
              ref={gatesRef}
              value={gatesText}
              spellCheck={false}
              onChange={(e) => setGatesText(e.target.value)}
              aria-label="门定义编辑区，每行 名称 类型 输入列表"
            />
          </EditorPanel>

          <EditorPanel title="顶事件" counter="单个门名称" errorLines={issueLines.top} warnLines={new Set()}>
            <input
              ref={topRef}
              value={topText}
              spellCheck={false}
              onChange={(e) => setTopText(e.target.value)}
              aria-label="顶事件门名称"
            />
          </EditorPanel>

          <div className="actions">
            <button
              type="button"
              onClick={() => { setEventsText(SAMPLE_EVENTS); setGatesText(SAMPLE_GATES); setTopText(SAMPLE_TOP); }}
            >
              载入示例（仅标识）
            </button>
            <button
              type="button"
              onClick={() => { setEventsText(SAMPLE_EVENTS_WITH_PROB); setGatesText(SAMPLE_GATES); setTopText(SAMPLE_TOP); }}
            >
              载入示例（含概率）
            </button>
            <button
              type="button"
              onClick={() => { setEventsText(STRESS_EVENTS_HALF); setGatesText(STRESS_GATES); setTopText(STRESS_TOP); }}
              title="割集高度重叠：定性完整，但精确定量状态数超过 200000，显示 quantitative_limit"
            >
              压力示例（触发定量上限）
            </button>
            <button
              type="button"
              onClick={() => { setEventsText(STRESS_EVENTS_ZERO); setGatesText(STRESS_GATES); setTopText(STRESS_TOP); }}
              title="与压力示例同构，仅把概率全部改为 0：确定性剪枝使定量结果立即恢复"
            >
              压力示例（概率全 0 · 恢复）
            </button>
            <button type="button" onClick={() => { setEventsText(''); setGatesText(''); setTopText(''); }}>
              全部清空
            </button>
          </div>
        </section>

        <section className="results">
          {result.status === 'invalid' && <InvalidPanel issues={result.issues} onLocate={locate} />}
          {result.status === 'complexity_limit' && (
            <LimitPanel gate={result.gate} line={result.line} limit={result.limit} partial={result.partialGateCounts} />
          )}
          {result.status === 'complete' && (
            <CompletePanel result={result} eventFields={eventFields} onLocateLine={locateLine} />
          )}
        </section>
      </div>
    </div>
  );
}

function EditorPanel(props: {
  title: string;
  counter: string;
  errorLines: Set<number>;
  warnLines: Set<number>;
  children: React.ReactNode;
}): JSX.Element {
  const cls = props.errorLines.size > 0 ? 'panel-error' : props.warnLines.size > 0 ? 'panel-warn' : '';
  return (
    <div className={`panel ${cls}`}>
      <div className="panel-head">
        <h2>{props.title}</h2>
        <span className="counter">{props.counter}</span>
      </div>
      {props.errorLines.size > 0 && (
        <div className="line-tags">
          问题行：{[...props.errorLines].sort((a, b) => a - b).map((n) => (
            <span key={n} className="line-tag">第 {n} 行</span>
          ))}
        </div>
      )}
      {props.errorLines.size === 0 && props.warnLines.size > 0 && (
        <div className="line-tags line-tags-warn">
          概率缺失/非法行（定性结论不受影响，定量复核待补全或修正）：
          {[...props.warnLines].sort((a, b) => a - b).map((n) => (
            <span key={n} className="line-tag line-tag-warn">第 {n} 行</span>
          ))}
        </div>
      )}
      {props.children}
    </div>
  );
}

function InvalidPanel(props: { issues: Issue[]; onLocate: (i: Issue) => void }): JSX.Element {
  return (
    <div className="panel result-panel">
      <div className="panel-head">
        <h2 className="status-bad">输入非法（{props.issues.length} 项）</h2>
      </div>
      <p className="note">原始输入已保留，点击任一问题可定位到对应编辑位置。修复前不会给出割集结论。</p>
      <ul className="issue-list">
        {props.issues.map((issue, idx) => (
          <li key={`${issue.code}-${idx}`}>
            <button type="button" className="issue-btn" onClick={() => props.onLocate(issue)}>
              <span className="issue-code">{issue.code}</span>
              <span className="issue-msg">{issue.message}</span>
              <span className="issue-loc">
                {areaLabel(issue.location.area)}
                {issue.location.line !== undefined ? ` 第 ${issue.location.line} 行` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LimitPanel(props: { gate: string; line: number; limit: number; partial: Record<string, number> }): JSX.Element {
  const completed = Object.entries(props.partial).sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <div className="panel result-panel">
      <div className="panel-head">
        <h2 className="status-limit">complexity_limit</h2>
      </div>
      <div className="limit-banner">
        <strong>结论不完整，不得作为完整最小割集结论使用。</strong>
        <p>
          门 <code>{props.gate}</code>（门定义第 {props.line} 行）规范化后的最小割集数量超过上限{' '}
          {props.limit} 个，展开已在该门处中止。顶事件割集与事件归属均未给出，
          因为截断结果可能遗漏更小的解释（吸收律消去尚未完成）。
        </p>
        <p className="note">
          请拆分该门、引入中间层或重新建模以降低组合复杂度后重试。
        </p>
      </div>
      <h3>已完成规范化的门（仅供排障参考，非完整结果）</h3>
      <table className="data-table">
        <thead><tr><th>门</th><th>割集数</th></tr></thead>
        <tbody>
          {completed.map(([name, n]) => (
            <tr key={name} className={name === props.gate ? 'row-hit' : ''}>
              <td>{name}</td><td>{n}</td>
            </tr>
          ))}
          <tr className="row-hit"><td>{props.gate}</td><td>&gt; {props.limit}（中止）</td></tr>
        </tbody>
      </table>
    </div>
  );
}

function CompletePanel(props: {
  result: CompleteAnalysis;
  eventFields: EventFieldInfo[];
  onLocateLine: (area: AreaKey, line?: number) => void;
}): JSX.Element {
  const { result, eventFields } = props;
  const [selected, setSelected] = useState<string | null>(null);

  // 编辑导致已选事件消失（仍为 complete）时清除选择。
  useEffect(() => {
    if (selected !== null && !(selected in result.classification)) setSelected(null);
  }, [selected, result.classification]);

  const quant = useMemo<QuantitativeResult>(() => {
    const collected = collectProbabilityEntries(eventNamesOf(result), eventFields);
    if ('problems' in collected) return { status: 'prob_invalid', problems: collected.problems };
    return analyzeQuantitative(result, collected.entries);
  }, [result, eventFields]);

  const groups: { role: EventRole; events: string[] }[] = [
    { role: 'mandatory', events: [] },
    { role: 'optional', events: [] },
    { role: 'irrelevant', events: [] }
  ];
  for (const [name, role] of Object.entries(result.classification)) {
    groups.find((g) => g.role === role)!.events.push(name);
  }
  groups.forEach((g) => g.events.sort((a, b) => a.localeCompare(b)));

  const gateEntries = Object.entries(result.gateCounts).sort((a, b) => a[0].localeCompare(b[0]));

  const affected = selected === null ? null : countAffected(result, selected);
  const selectedQuant =
    quant.status === 'quant_ok' && selected
      ? quant.events.find((e) => e.event === selected) ?? null
      : null;

  return (
    <>
      <div className="panel result-panel">
        <div className="panel-head">
          <h2 className="status-ok">顶事件 {result.top} 的最小割集（{result.cutsets.length} 个）</h2>
          {selected && (
            <span className="select-info">
              已选 <code>{selected}</code>：受影响解释 {affected!.hit}/{affected!.total}
              <button type="button" className="mini-btn" onClick={() => setSelected(null)}>取消选择</button>
            </span>
          )}
        </div>
        {result.cutsets.length === 0 ? (
          <p className="note">顶事件不存在任何割集——按当前模型顶事件不可能发生。</p>
        ) : (
          <ol className="cutset-list">
            {result.cutsets.map((cs, i) => {
              const hit = selected !== null && cs.includes(selected);
              const dim = selected !== null && !hit;
              return (
                <li key={i} className={`cutset ${hit ? 'cutset-hit' : ''} ${dim ? 'cutset-dim' : ''}`}>
                  <span className="cutset-index">{i + 1}.</span>
                  {cs.map((e, j) => (
                    <span key={e} className="cutset-events">
                      <code className={e === selected ? 'event-picked' : ''}>{e}</code>
                      {j < cs.length - 1 ? ' ∧ ' : ''}
                    </span>
                  ))}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div className="panel result-panel">
        <div className="panel-head"><h2>基本事件归属</h2></div>
        <table className="data-table classification">
          <thead><tr><th>类别</th><th>含义</th><th>事件</th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.role}>
                <td><span className={`badge badge-${g.role}`}>{ROLE_LABEL[g.role]}</span></td>
                <td className="hint">{ROLE_HINT[g.role]}</td>
                <td>
                  {g.events.length
                    ? g.events.map((e) => (
                        <button
                          key={e}
                          type="button"
                          className={`event-chip chip-btn ${e === selected ? 'chip-picked' : ''}`}
                          onClick={() => setSelected(e === selected ? null : e)}
                          title="点击在割集列表中标出受其影响的解释"
                        >
                          {e}
                        </button>
                      ))
                    : <span className="muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <QuantitativePanel
        result={result}
        quant={quant}
        selected={selected}
        onSelect={setSelected}
        onLocateLine={props.onLocateLine}
      />
      {selectedQuant && quant.status === 'quant_ok' && (
        <ConsistencyPanel top={quant.top} q={selectedQuant} />
      )}

      <div className="panel result-panel">
        <div className="panel-head"><h2>各门规范化割集数（共享子门仅计算一次）</h2></div>
        <table className="data-table compact">
          <thead><tr><th>门</th><th>最小割集数</th></tr></thead>
          <tbody>
            {gateEntries.map(([name, n]) => (
              <tr key={name}><td><code>{name}</code></td><td>{n}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function eventNamesOf(result: CompleteAnalysis): string[] {
  return Object.keys(result.classification);
}

function countAffected(result: CompleteAnalysis, event: string): { hit: number; total: number } {
  let hit = 0;
  for (const cs of result.cutsets) if (cs.includes(event)) hit += 1;
  return { hit, total: result.cutsets.length };
}

function QuantitativePanel(props: {
  result: CompleteAnalysis;
  quant: QuantitativeResult;
  selected: string | null;
  onSelect: (e: string | null) => void;
  onLocateLine: (area: AreaKey, line?: number) => void;
}): JSX.Element {
  const { quant } = props;
  return (
    <div className="panel result-panel">
      <div className="panel-head">
        <h2>定量复核 · 独立失效概率</h2>
      </div>
      <p className="note">
        在“基本事件”每行第二字段填写概率（0–1、至多六位小数）；事件相互独立。
        顶事件概率按割集的重叠结构精确计算（Shannon 分解，BigInt 有理算术，
        不把共享事件的割集当作互斥项相加）。仅标识行仍完成全部定性审计；
        概率缺失或非法时只阻止定量结论。
      </p>

      {quant.status === 'prob_invalid' && <ProbInvalidPanel problems={quant.problems} onLocateLine={props.onLocateLine} />}
      {quant.status === 'quantitative_limit' && <QuantLimitPanel limit={quant.limit} nodes={quant.nodes} />}
      {quant.status === 'quant_ok' && (
        <QuantOkPanel quant={quant} selected={props.selected} onSelect={props.onSelect} />
      )}
    </div>
  );
}

function ProbInvalidPanel(props: {
  problems: ProbabilityProblem[];
  onLocateLine: (area: AreaKey, line?: number) => void;
}): JSX.Element {
  const missing = props.problems.filter((p) => p.kind === 'missing');
  const invalid = props.problems.filter((p) => p.kind === 'invalid');
  return (
    <div className="quant-block">
      <div className="quant-banner quant-banner-warn">
        <strong>定量结论暂不可用（定性割集与归属结论仍然完整有效）。</strong>
        <p className="note">
          {missing.length > 0 && ` ${missing.length} 个事件缺少概率字段；`}
          {invalid.length > 0 && ` ${invalid.length} 个事件的概率非法；`}
          补全并修正为 0–1 内至多六位小数的十进制数后，定量结果立即恢复，无需其他操作。
        </p>
      </div>
      <table className="data-table compact">
        <thead><tr><th>事件</th><th>问题</th><th>原文</th><th>说明 / 定位</th></tr></thead>
        <tbody>
          {[...props.problems]
            .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name))
            .map((p) => (
              <tr key={`${p.line}-${p.name}`}>
                <td><code>{p.name}</code></td>
                <td className={p.kind === 'invalid' ? 'status-bad' : 'status-limit'}>
                  {p.kind === 'missing' ? '缺失' : '非法'}
                </td>
                <td>{p.raw ? <code>{p.raw}</code> : <span className="muted">（空）</span>}</td>
                <td>
                  {p.reason ?? '在事件行第二字段填写概率'}{' '}
                  <button type="button" className="mini-btn" onClick={() => props.onLocateLine('events', p.line)}>
                    定位第 {p.line} 行
                  </button>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function QuantLimitPanel(props: { limit: number; nodes: number }): JSX.Element {
  return (
    <div className="quant-banner quant-banner-limit">
      <h3 className="status-limit" style={{ marginTop: 0 }}>quantitative_limit</h3>
      <strong>定量计算超过确定性资源上限，未输出任何概率（包括顶事件概率）。</strong>
      <p className="note">
        不同状态的精确求值数已达到上限 {props.limit}（当前 {props.nodes}）。
        为避免给出未经完整求值的部分概率，定量结论整体中止；上方的定性最小割集与事件归属
        仍然完整保留。修正输入（降低事件规模或调整概率结构）后定量结果立即恢复。
      </p>
    </div>
  );
}

function QuantOkPanel(props: {
  quant: Extract<QuantitativeResult, { status: 'quant_ok' }>;
  selected: string | null;
  onSelect: (e: string | null) => void;
}): JSX.Element {
  const { quant } = props;
  return (
    <div className="quant-block">
      <div className="top-prob">
        <span className="top-prob-label">顶事件概率 P(T)（精确值）</span>
        <code className="top-prob-value">{quant.top.decimal}</code>
        <span className="muted small">
          = {quant.top.numerator.toString()} / {quant.top.denominator.toString()}
        </span>
      </div>
      <table className="data-table quant-table">
        <thead>
          <tr>
            <th>事件（点击选择）</th>
            <th>原概率 p</th>
            <th>强制未发生 P(T|e=0)</th>
            <th>强制已发生 P(T|e=1)</th>
            <th>差值 Δ = P1−P0</th>
            <th>一致关系</th>
          </tr>
        </thead>
        <tbody>
          {quant.events.map((q) => (
            <tr key={q.event} className={q.event === props.selected ? 'row-selected' : ''}>
              <td>
                <button
                  type="button"
                  className={`event-chip chip-btn ${q.event === props.selected ? 'chip-picked' : ''}`}
                  onClick={() => props.onSelect(q.event === props.selected ? null : q.event)}
                >
                  {q.event}
                </button>
              </td>
              <td><Dec value={q.p} input={q.input} /></td>
              <td><Dec value={q.absent} /></td>
              <td><Dec value={q.present} /></td>
              <td><Dec value={q.delta} /></td>
              <td>
                <span className={q.identityHolds ? 'status-ok' : 'status-bad'}>
                  {q.identityHolds ? '✓ 全概率分解' : '✗ 全概率分解'}
                </span>
                <br />
                <span className={q.orderHolds ? 'status-ok' : 'status-bad'}>
                  {q.orderHolds ? '✓ P0≤P(T)≤P1' : '✗ 偏序'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Dec(props: { value: { decimal: string; numerator: bigint; denominator: bigint }; input?: string }): JSX.Element {
  return (
    <code className="dec" title={`${props.value.numerator.toString()} / ${props.value.denominator.toString()}`}>
      {props.value.decimal}
      {props.input !== undefined && <span className="muted small">（输入 {props.input}）</span>}
    </code>
  );
}

function ConsistencyPanel(props: {
  top: Extract<QuantitativeResult, { status: 'quant_ok' }>['top'];
  q: EventQuantitative;
}): JSX.Element {
  const { top, q } = props;
  return (
    <div className="panel result-panel consistency-panel">
      <div className="panel-head">
        <h2>事件 {q.event} 的干预核对</h2>
      </div>
      <ul className="note" style={{ marginTop: 0 }}>
        <li>
          原概率 p = <code>{q.p.decimal}</code>（按输入十进制 {q.input} 的精确值）
        </li>
        <li>
          强制未发生：P(T | {q.event}=0) = <code>{q.absent.decimal}</code>
          ；强制已发生：P(T | {q.event}=1) = <code>{q.present.decimal}</code>
        </li>
        <li>
          差值 Δ = P(T|e=1) − P(T|e=0) = <code>{q.delta.decimal}</code>
          {q.delta.numerator === 0n && '（该事件对顶事件无边际影响，例如无关事件或概率边界情形）'}
        </li>
        <li>
          全概率分解：(1−p)·P(T|e=0) + p·P(T|e=1) = <code>{top.decimal}</code> = P(T)
          <strong className={q.identityHolds ? 'status-ok' : 'status-bad'}>
            {' '}{q.identityHolds ? '✓ 精确相等' : '✗ 不一致'}
          </strong>
        </li>
        <li>
          偏序核对：P(T|e=0) ≤ P(T) ≤ P(T|e=1)
          <strong className={q.orderHolds ? 'status-ok' : 'status-bad'}>
            {' '}{q.orderHolds ? '✓ 成立' : '✗ 不成立'}
          </strong>
        </li>
      </ul>
      <p className="note">割集列表中已同步标出所有包含 {q.event} 的最小割集（高亮项即受其影响的解释）。</p>
    </div>
  );
}

function areaLabel(area: string): string {
  return area === 'events' ? '基本事件' : area === 'gates' ? '门定义' : '顶事件';
}
