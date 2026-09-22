import { useMemo, useRef, useState } from 'react';
import { audit } from './core/pipeline';
import { parseProbabilityInput, quantify } from './core/probability';
import type { CompleteAnalysis, EventRole, Issue } from './core/types';
import { Decimal } from './core/decimal';
import { SAMPLE_EVENTS, SAMPLE_GATES, SAMPLE_TOP } from './sample';

type AreaKey = 'events' | 'gates' | 'top';

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

const PROB_PLACEHOLDER = '0–1，至多 6 位小数';

const SAMPLE_PROBABILITIES: Record<string, string> = {
  BUS_FAULT: '0.001',
  MAIN_SRC: '0.002',
  MAIN_SW: '0.001',
  BK_SRC: '0.005',
  BK_SW: '0.003',
  COMMON_CTRL: '0.0005',
  COSMIC: '0.01'
};

export function App(): JSX.Element {
  const [eventsText, setEventsText] = useState(SAMPLE_EVENTS);
  const [gatesText, setGatesText] = useState(SAMPLE_GATES);
  const [topText, setTopText] = useState(SAMPLE_TOP);
  // 概率输入按事件名留存：编辑树时同名事件已填概率不丢；缺失/非法文本原样保留。
  const [probInputs, setProbInputs] = useState<Record<string, string>>({});
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);

  const eventsRef = useRef<HTMLTextAreaElement>(null);
  const gatesRef = useRef<HTMLTextAreaElement>(null);
  const topRef = useRef<HTMLInputElement>(null);
  const refs: EditorRefs = { events: eventsRef, gates: gatesRef, top: topRef };

  const result = useMemo(() => audit(eventsText, gatesText, topText), [eventsText, gatesText, topText]);

  const issueLines = useMemo(() => {
    const map: Record<AreaKey, Set<number>> = { events: new Set(), gates: new Set(), top: new Set() };
    if (result.status === 'invalid') {
      for (const issue of result.issues) {
        if (issue.location.line !== undefined) map[issue.location.area as AreaKey].add(issue.location.line);
      }
    }
    return map;
  }, [result]);

  // 定性完整时，概率文本逐条校验；非法/缺失只阻止定量结论，不影响割集与归属。
  const probState = useMemo(() => {
    if (result.status !== 'complete') return null;
    const values: Record<string, Decimal> = {};
    const problems: Array<{ event: string; reason: string }> = [];
    for (const e of Object.keys(result.classification)) {
      const raw = probInputs[e] ?? '';
      const parsed = parseProbabilityInput(raw);
      if (parsed.ok && parsed.value) {
        values[e] = parsed.value;
      } else {
        problems.push({ event: e, reason: probabilityReasonLabel(parsed.reason) });
      }
    }
    return { values, problems, allValid: problems.length === 0 };
  }, [result, probInputs]);

  const quant = useMemo(() => {
    if (!probState || !probState.allValid || result.status !== 'complete') return null;
    const eventOrder = Object.keys(result.classification).sort((a, b) => a.localeCompare(b));
    return quantify(eventOrder, result.cutsets, probState.values);
  }, [probState, result]);

  const effectiveSelected =
    selectedEvent && result.status === 'complete' && selectedEvent in result.classification
      ? selectedEvent
      : null;

  const locate = (issue: Issue): void => {
    const target = refs[issue.location.area as AreaKey].current;
    if (!target) return;
    target.focus();
    if (issue.location.area === 'top' || issue.location.line === undefined) {
      (target as HTMLInputElement).select?.();
      return;
    }
    const textarea = target as HTMLTextAreaElement;
    const lines = textarea.value.split(/\r?\n/);
    let start = 0;
    for (let i = 0; i < issue.location.line - 1 && i < lines.length; i += 1) {
      start += lines[i].length + 1;
    }
    const end = start + (lines[issue.location.line - 1]?.length ?? 0);
    textarea.setSelectionRange(start, end);
    // 估算滚动位置（约 18px/行）并将问题行置于可视区上部
    const approxLineHeight = 18;
    textarea.scrollTop = Math.max(0, (issue.location.line - 3) * approxLineHeight);
  };

  const eventCount = eventsText.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length;
  const gateCount = gatesText.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length;

  return (
    <div className="page">
      <header className="topbar">
        <h1>航天器供电故障树 · 最小割集审计</h1>
        <p className="subtitle">
          全部计算在浏览器本地完成 · 无业务后端、无在线调用 · 共享有向无环图精确展开 ·
          单门规范化割集上限 2000 · 定量复核精确十进制（无浮点）
        </p>
      </header>

      <div className="layout">
        <section className="editors">
          <EditorPanel
            title="基本事件"
            counter={`${eventCount} 个（允许 2–30）`}
            errorLines={issueLines.events}
          >
            <textarea
              ref={eventsRef}
              value={eventsText}
              spellCheck={false}
              onChange={(e) => setEventsText(e.target.value)}
              aria-label="基本事件编辑区，每行一个 ASCII 标识"
            />
          </EditorPanel>

          <EditorPanel
            title="门定义"
            counter={`${gateCount} 个（允许 1–80），语法：名称 AND|OR 输入...`}
            errorLines={issueLines.gates}
          >
            <textarea
              ref={gatesRef}
              value={gatesText}
              spellCheck={false}
              onChange={(e) => setGatesText(e.target.value)}
              aria-label="门定义编辑区，每行 名称 类型 输入列表"
            />
          </EditorPanel>

          <EditorPanel title="顶事件" counter="单个门名称" errorLines={issueLines.top}>
            <input
              ref={topRef}
              value={topText}
              spellCheck={false}
              onChange={(e) => setTopText(e.target.value)}
              aria-label="顶事件门名称"
            />
          </EditorPanel>

          <div className="actions">
            <button type="button" onClick={() => { setEventsText(SAMPLE_EVENTS); setGatesText(SAMPLE_GATES); setTopText(SAMPLE_TOP); }}>
              载入示例
            </button>
            <button type="button" onClick={() => { setEventsText(''); setGatesText(''); setTopText(''); }}>
              全部清空
            </button>
          </div>
        </section>

        <section className="results">
          {result.status === 'invalid' && <InvalidPanel issues={result.issues} onLocate={locate} />}
          {result.status === 'complexity_limit' && <LimitPanel gate={result.gate} line={result.line} limit={result.limit} partial={result.partialGateCounts} />}
          {result.status === 'complete' && (
            <CompletePanel
              result={result}
              probInputs={probInputs}
              onProbChange={(event, value) => setProbInputs((prev) => ({ ...prev, [event]: value }))}
              probState={probState}
              quant={quant}
              selectedEvent={effectiveSelected}
              onSelectEvent={setSelectedEvent}
              onFillSample={() => setProbInputs((prev) => ({ ...prev, ...SAMPLE_PROBABILITIES }))}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function probabilityReasonLabel(reason?: string): string {
  if (reason === 'empty') return '未填写概率';
  if (reason === 'range') return '概率超出 [0, 1]（如 1.000001 非法）';
  return '须为 0–1 的十进制数、至多 6 位小数（如 0.001 或 1.000000）';
}

function EditorPanel(props: {
  title: string;
  counter: string;
  errorLines: Set<number>;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className={`panel ${props.errorLines.size > 0 ? 'panel-error' : ''}`}>
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

interface CompletePanelProps {
  result: CompleteAnalysis;
  probInputs: Record<string, string>;
  onProbChange: (event: string, value: string) => void;
  probState: { values: Record<string, Decimal>; problems: Array<{ event: string; reason: string }>; allValid: boolean } | null;
  quant: ReturnType<typeof quantify> | null;
  selectedEvent: string | null;
  onSelectEvent: (event: string | null) => void;
  onFillSample: () => void;
}

function CompletePanel(props: CompletePanelProps): JSX.Element {
  const { result, selectedEvent, onSelectEvent } = props;
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

  return (
    <>
      <div className="panel result-panel">
        <div className="panel-head">
          <h2 className="status-ok">顶事件 {result.top} 的最小割集（{result.cutsets.length} 个）</h2>
          {selectedEvent && (
            <button type="button" className="clear-select" onClick={() => onSelectEvent(null)}>
              取消事件选中（当前：{selectedEvent}）
            </button>
          )}
        </div>
        {result.cutsets.length === 0 ? (
          <p className="note">顶事件不存在任何割集——按当前模型顶事件不可能发生。</p>
        ) : (
          <ol className="cutset-list">
            {result.cutsets.map((cs, i) => {
              const affected = selectedEvent !== null && cs.includes(selectedEvent);
              return (
                <li
                  key={i}
                  className={
                    selectedEvent === null
                      ? 'cutset'
                      : affected
                        ? 'cutset cutset-affected'
                        : 'cutset cutset-dimmed'
                  }
                >
                  <span className="cutset-index">{i + 1}.</span>
                  {cs.map((e, j) => (
                    <span key={e} className="cutset-events">
                      <button
                        type="button"
                        className={`chip-btn ${e === selectedEvent ? 'chip-btn-on event-hit' : ''}`}
                        title="点击选中该事件，联动查看定量干预"
                        onClick={() => onSelectEvent(e)}
                      >
                        {e}
                      </button>
                      {j < cs.length - 1 ? ' ∧ ' : ''}
                    </span>
                  ))}
                  {affected && <span className="affected-tag">受 {selectedEvent} 影响</span>}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <QuantitativePanel {...props} eventNames={groups.flatMap((g) => g.events)} />

      <div className="panel result-panel">
        <div className="panel-head"><h2>基本事件归属</h2></div>
        <table className="data-table classification">
          <thead><tr><th>类别</th><th>含义</th><th>事件</th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.role}>
                <td><span className={`badge badge-${g.role}`}>{ROLE_LABEL[g.role]}</span></td>
                <td className="hint">{ROLE_HINT[g.role]}</td>
                <td>{g.events.length ? g.events.map((e) => (
                  <button
                    type="button"
                    key={e}
                    className={`event-chip chip-btn ${e === selectedEvent ? 'chip-btn-on' : ''}`}
                    onClick={() => onSelectEvent(e)}
                  >
                    {e}
                  </button>
                )) : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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

function QuantitativePanel(props: CompletePanelProps & { eventNames: string[] }): JSX.Element {
  const { result, probInputs, onProbChange, probState, quant, selectedEvent, onSelectEvent, onFillSample } = props;
  const problemOf = new Map(probState!.problems.map((p) => [p.event, p.reason]));

  return (
    <div className="panel result-panel quant-panel">
      <div className="panel-head">
        <h2>独立失效概率分析（定量复核）</h2>
        <span className="counter">为每个基本事件填写概率后给出精确结论</span>
      </div>
      <p className="note">
        多个最小割集会共享基本事件，顶事件概率按“至少一个割集全部发生”的并事件精确展开
        （香农不交分解），<strong>不会</strong>把重叠割集当作互斥项直接相加。
        全部数值使用 bigint 十进制精确运算（无浮点、无舍入）。仅标识输入的旧模型
        无需概率即可完成上方定性割集与归属审计；概率缺失或非法时只阻止本面板结论。
      </p>

      <div className="actions quant-actions">
        <button type="button" onClick={onFillSample}>填入示例概率</button>
        <button type="button" onClick={() => props.eventNames.forEach((e) => onProbChange(e, ''))}>清空全部概率</button>
      </div>

      <table className="data-table prob-table">
        <thead>
          <tr>
            <th className="col-select">选择</th>
            <th>基本事件</th>
            <th>归属</th>
            <th className="col-prob">独立失效概率</th>
            <th>输入状态</th>
          </tr>
        </thead>
        <tbody>
          {props.eventNames.map((e) => {
            const issue = problemOf.get(e);
            return (
              <tr
                key={e}
                className={e === selectedEvent ? 'row-selected' : undefined}
                onClick={() => onSelectEvent(e)}
              >
                <td>
                  <input
                    type="radio"
                    name="selected-event"
                    checked={e === selectedEvent}
                    onChange={() => onSelectEvent(e)}
                    aria-label={`选中事件 ${e}`}
                    onClick={(ev) => ev.stopPropagation()}
                  />
                </td>
                <td><code>{e}</code></td>
                <td><span className={`badge badge-${result.classification[e]}`}>{ROLE_LABEL[result.classification[e]]}</span></td>
                <td onClick={(ev) => ev.stopPropagation()}>
                  <input
                    type="text"
                    className="prob-input"
                    inputMode="decimal"
                    spellCheck={false}
                    placeholder={PROB_PLACEHOLDER}
                    aria-label={`${e} 的失效概率`}
                    data-testid={`prob-input-${e}`}
                    value={probInputs[e] ?? ''}
                    onChange={(ev2) => onProbChange(e, ev2.target.value)}
                  />
                </td>
                <td className={issue ? 'prob-bad' : 'prob-ok'}>
                  {issue ? issue : '✓ 有效'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {!probState!.allValid && (
        <div className="quant-blocked" data-testid="quant-blocked">
          <strong>定量结论暂不可用：</strong>
          尚有 {probState!.problems.length} 个事件的概率缺失或非法（见上表），文本均已保留；
          修正后立即恢复。此状态不影响上方的定性割集与归属结论。
        </div>
      )}

      {probState!.allValid && quant?.status === 'quantitative_limit' && (
        <div className="limit-banner quant-limit" data-testid="quant-limit">
          <h2 className="status-limit">quantitative_limit</h2>
          <p>
            <strong>定量复核超过确定性资源上限（{quant.budget.toLocaleString('en-US')} 个不交化状态），
            已中止且不展示任何概率——包括顶事件概率在内的部分概率都可能不完整。</strong>
          </p>
          <p>
            上方的定性最小割集与事件归属是完整结论，继续保留可用。请简化故障树
            （拆分/共享中间门以减少割集组合）后重试：输入一经修正，完整定量结果立即恢复。
          </p>
        </div>
      )}

      {probState!.allValid && quant?.status === 'ok' && (
        <QuantResults result={result} quant={quant} selectedEvent={selectedEvent} onSelectEvent={onSelectEvent} />
      )}
    </div>
  );
}

function QuantResults(props: {
  result: CompleteAnalysis;
  quant: Extract<ReturnType<typeof quantify>, { status: 'ok' }>;
  selectedEvent: string | null;
  onSelectEvent: (event: string | null) => void;
}): JSX.Element {
  const { quant, selectedEvent } = props;
  const selected = selectedEvent ? quant.events[selectedEvent] : null;

  // 一致性核对（恒等式）：P(T) = p·P(T‖X=1) + (1−p)·P(T‖X=0)，精确十进制验证。
  let identity: { recon: Decimal; match: boolean } | null = null;
  if (selectedEvent && selected) {
    const p = selected.probability;
    const recon = p.mul(selected.forcedOccurred).add(Decimal.ONE.sub(p).mul(selected.forcedAbsent));
    identity = { recon, match: recon.equals(quant.topProbability) };
  }

  return (
    <div className="quant-results" data-testid="quant-results">
      <div className="top-prob">
        <span className="top-prob-label">顶事件 {props.result.top} 发生概率 P(T) =</span>
        <code className="top-prob-value" data-testid="top-probability">{quant.topProbability.toString()}</code>
        <span className="note">（按输入十进制精确计算，重叠割集未重复计）</span>
      </div>

      <h3>逐事件干预（强制未发生 / 强制已发生）</h3>
      <div className="table-scroll">
      <table className="data-table quant-out-table">
        <thead>
          <tr>
            <th>事件</th>
            <th>原概率 p</th>
            <th>强制未发生 P(T‖X=0)</th>
            <th>强制已发生 P(T‖X=1)</th>
            <th>差值 Δ = P1 − P0</th>
          </tr>
        </thead>
        <tbody>
          {Object.keys(quant.events).sort((a, b) => a.localeCompare(b)).map((e) => {
            const v = quant.events[e];
            return (
              <tr
                key={e}
                className={e === selectedEvent ? 'row-selected' : undefined}
                onClick={() => props.onSelectEvent(e)}
              >
                <td><code>{e}</code>{!v.relevant && <span className="muted">（无关，干预无影响）</span>}</td>
                <td className="num">{v.probability.toString()}</td>
                <td className="num">{v.forcedAbsent.toString()}</td>
                <td className="num">{v.forcedOccurred.toString()}</td>
                <td className="num">{v.diff.isZero ? <span className="muted">0</span> : v.diff.toString()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      {selectedEvent && selected && identity && (
        <div className="identity-box" data-testid="identity-box">
          <h3>一致性核对 · 事件 {selectedEvent}</h3>
          <p className="identity-line">
            原概率 p = <code>{selected.probability.toString()}</code>；
            强制未发生 P0 = <code>{selected.forcedAbsent.toString()}</code>；
            强制已发生 P1 = <code>{selected.forcedOccurred.toString()}</code>；
            差值 Δ = P1 − P0 = <code>{selected.diff.toString()}</code>
            （单调故障树中 Δ ≥ 0：<strong>{selected.diff.isZero || cmpGe(selected.forcedOccurred, selected.forcedAbsent) ? '成立 ✓' : '不成立 ✗'}</strong>）。
          </p>
          <p className="identity-line">
            全概率恒等式 p·P1 + (1−p)·P0 = <code>{identity.recon.toString()}</code>
            ，与顶事件概率 P(T) = <code>{quant.topProbability.toString()}</code>{' '}
            <strong>{identity.match ? '精确相等 ✓' : '不一致 ✗'}</strong>。
          </p>
          <p className="note">
            上方割集列表已联动标出所有包含 {selectedEvent} 的最小割集（共{' '}
            {props.result.cutsets.filter((cs) => cs.includes(selectedEvent)).length} 个）。
          </p>
        </div>
      )}
      {!selectedEvent && (
        <p className="note">点击任一事件（单选框、割集内标识或归属表标签）可联动高亮受其影响的割集，并核对原概率、两种干预结果与差值的一致关系。</p>
      )}
    </div>
  );
}

/** 比较两个精确小数 a >= b（避开给 Decimal 再加比较 API 的最小实现）。 */
function cmpGe(a: Decimal, b: Decimal): boolean {
  const scale = Math.max(a.scale, b.scale);
  const av = a.coef * 10n ** BigInt(scale - a.scale);
  const bv = b.coef * 10n ** BigInt(scale - b.scale);
  return av >= bv;
}

function areaLabel(area: string): string {
  return area === 'events' ? '基本事件' : area === 'gates' ? '门定义' : '顶事件';
}
