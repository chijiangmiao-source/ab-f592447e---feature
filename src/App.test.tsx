// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';

const containers: HTMLElement[] = [];

function render(): { container: HTMLElement; root: ReturnType<typeof createRoot> } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  act(() => root.render(<App />));
  return { container, root };
}

afterEach(() => {
  for (const c of containers) {
    act(() => c.textContent && (c.innerHTML = ''));
  }
  containers.length = 0;
});

function setNative(el: Element, value: string): void {
  const proto = Object.getPrototypeOf(el) as unknown as { value: string };
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// 与 scratch 生成器同一固定 LCG（seed=42）产生的前 79 个三元割集：
// 30 事件 / 80 门内定性完整，但定量不交化超过 50_000 状态预算。
function hardTriples(): Array<[number, number, number]> {
  let seed = 42;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const triples: Array<[number, number, number]> = [];
  const seen = new Set<string>();
  while (triples.length < 79) {
    const a = Math.floor(rand() * 30);
    let b = Math.floor(rand() * 30);
    while (b === a) b = Math.floor(rand() * 30);
    let c = Math.floor(rand() * 30);
    while (c === a || c === b) c = Math.floor(rand() * 30);
    const key = [a, b, c].sort((x, y) => x - y).join(',');
    if (!seen.has(key)) {
      seen.add(key);
      triples.push([a, b, c].sort((x, y) => x - y) as [number, number, number]);
    }
  }
  return triples;
}

function hardModel(): { events: string; gates: string } {
  const triples = hardTriples();
  const events = Array.from({ length: 30 }, (_, i) => `E${i}`).join('\n');
  const names = triples.map((_, i) => `G${String(i).padStart(2, '0')}`);
  const lines = triples.map((t, i) => `${names[i]} AND E${t[0]} E${t[1]} E${t[2]}`);
  lines.push(`TOP OR ${names.join(' ')}`);
  return { events: events + '\n', gates: lines.join('\n') + '\n' };
}

describe('App 页面', () => {
  it('渲染示例并显示 8 个割集与“无关”分类', () => {
    const { container } = render();
    const heading = container.textContent ?? '';
    expect(heading).toContain('最小割集（8 个）');
    expect(heading).toContain('无关');
    expect(heading).toContain('COSMIC');
    // 共享门计数表
    expect(heading).toContain('LOSS');
  });

  it('保留非法输入并显示可点击的问题定位', () => {
    const { container } = render();
    const gateArea = container.querySelectorAll('textarea')[1];
    setNative(gateArea, 'G AND A MISSING');
    expect(container.textContent).toContain('missing_reference');
  });

  it('超限输入显示 complexity_limit 警示且不输出割集', () => {
    const { container } = render();
    const areas = container.querySelectorAll('textarea');
    const ev: string[] = [];
    const lines: string[] = [];
    for (let g = 0; g < 7; g += 1) {
      const members = [`e${g}_0`, `e${g}_1`, `e${g}_2`];
      ev.push(...members);
      lines.push(`GRP${g} OR ${members.join(' ')}`);
    }
    lines.push('BIG AND GRP0 GRP1 GRP2 GRP3 GRP4 GRP5 GRP6');
    setNative(areas[0], ev.join('\n'));
    setNative(areas[1], lines.join('\n'));
    const topInput = container.querySelector('input')!;
    setNative(topInput, 'BIG');

    const text = container.textContent ?? '';
    expect(text).toContain('complexity_limit');
    expect(text).toContain('结论不完整');
    expect(text).not.toContain('最小割集（0 个）');
  });

  it('旧的仅标识输入：定性结论完整，概率缺失时只阻止定量结论并保留文本', () => {
    const { container } = render();
    const text = () => container.textContent ?? '';
    expect(text()).toContain('独立失效概率分析');
    expect(text()).toContain('定量结论暂不可用');
    // 定性割集与归属照常存在
    expect(text()).toContain('最小割集（8 个）');
    expect(container.querySelector('[data-testid="top-probability"]')).toBeNull();
    // 填入一个非法概率：文本保留、给出具体原因、仍无任何概率结论
    const inputs = container.querySelectorAll<HTMLInputElement>('input.prob-input');
    expect(inputs.length).toBe(7);
    setNative(inputs[0], '0.1234567');
    expect((container.querySelector('input.prob-input') as HTMLInputElement).value).toBe('0.1234567');
    expect(text()).toContain('至多 6 位小数');
    expect(container.querySelector('[data-testid="quant-results"]')).toBeNull();
    // 越界值
    setNative(inputs[0], '1.000001');
    expect(text()).toContain('概率超出');
  });

  it('全部概率有效后精确计算顶事件概率，重叠割集不互斥相加', () => {
    const { container } = render();
    const fill: Record<string, string> = {
      BUS_FAULT: '0.1', MAIN_SRC: '0.2', MAIN_SW: '0.3',
      BK_SRC: '0.4', BK_SW: '0.5', COMMON_CTRL: '0.01', COSMIC: '0.7'
    };
    for (const [name, value] of Object.entries(fill)) {
      const input = container.querySelector<HTMLInputElement>(`[data-testid="prob-input-${name}"]`)!;
      setNative(input, value);
    }
    const text = () => container.textContent ?? '';
    expect(container.querySelector('[data-testid="quant-blocked"]')).toBeNull();
    // 精确值（bigint 十进制）：8 个重叠三元割集的并事件概率
    expect(text()).toContain('0.033572');
    // 简单互斥相加会得到约 0.0768...，页面绝不能显示该值
    expect(text()).not.toContain('0.0768');
    // 干预表出现
    expect(text()).toContain('强制未发生');
    expect(text()).toContain('强制已发生');
  });

  it('选中事件联动高亮受影响割集并显示差值与全概率恒等式核对', () => {
    const { container } = render();
    // 先填全部概率
    const fill: Record<string, string> = {
      BUS_FAULT: '0.1', MAIN_SRC: '0.2', MAIN_SW: '0.3',
      BK_SRC: '0.4', BK_SW: '0.5', COMMON_CTRL: '0.01', COSMIC: '0.7'
    };
    for (const [name, value] of Object.entries(fill)) {
      setNative(container.querySelector<HTMLInputElement>(`[data-testid="prob-input-${name}"]`)!, value);
    }
    // 点击割集内的 COMMON_CTRL 标识
    const chips = [...container.querySelectorAll<HTMLButtonElement>('button.chip-btn')].filter(
      (b) => b.textContent === 'COMMON_CTRL'
    );
    expect(chips.length).toBeGreaterThan(0);
    act(() => chips[0].click());

    const affected = container.querySelectorAll('li.cutset-affected');
    const dimmed = container.querySelectorAll('li.cutset-dimmed');
    // COMMON_CTRL 出现在 4 个割集中（BK_SRC/MAIN_* 与 BK_SW/MAIN_* 各半）
    expect(affected.length).toBe(4);
    expect(dimmed.length).toBe(4);
    for (const li of affected) expect(li.textContent).toContain('COMMON_CTRL');

    const text = () => container.textContent ?? '';
    expect(text()).toContain('一致性核对 · 事件 COMMON_CTRL');
    expect(text()).toContain('精确相等 ✓');
    // 联动统计
    expect(text()).toContain('共 4 个');

    // 取消选中后恢复全部割集
    act(() => (container.querySelector('button.clear-select') as HTMLButtonElement).click());
    expect(container.querySelectorAll('li.cutset-affected').length).toBe(0);
    expect(container.querySelectorAll('li.cutset-dimmed').length).toBe(0);
  });

  it('概率 0/1 边界：顶事件概率与干预仍给出确定结果', () => {
    const { container } = render();
    // 简化为 {A},{B} 模型
    const areas = container.querySelectorAll('textarea');
    setNative(areas[0], 'A\nB\n');
    setNative(areas[1], 'TOP OR A B\n');
    const topInput = container.querySelector('input')!;
    setNative(topInput, 'TOP');
    setNative(container.querySelector<HTMLInputElement>('[data-testid="prob-input-A"]')!, '1');
    setNative(container.querySelector<HTMLInputElement>('[data-testid="prob-input-B"]')!, '0');
    const text = () => container.textContent ?? '';
    // P(T)=1；强制 A 未发生 => 0（B 概率为 0）
    expect(container.querySelector<HTMLInputElement>('[data-testid="top-probability"]')!.textContent).toBe('1');
    // 选中 A 后：P0=0、P1=1、Δ=1，全概率恒等式仍精确成立
    const rows = container.querySelectorAll('.quant-out-table tbody tr');
    act(() => rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(text()).toContain('一致性核对 · 事件 A');
    expect(text()).toContain('精确相等 ✓');
  });

  it('超过确定性资源上限时显示 quantitative_limit、保留定性割集、不出现任何概率，修正后恢复', () => {
    const { container } = render();
    const { events, gates } = hardModel();
    const areas = container.querySelectorAll('textarea');
    setNative(areas[0], events);
    setNative(areas[1], gates);
    setNative(container.querySelector('input')!, 'TOP');

    const text1 = () => container.textContent ?? '';
    // 定性完整：79 个割集保留
    expect(text1()).toContain('最小割集（79 个）');
    // 未填概率时只是 blocked，不是 quantitative_limit
    expect(container.querySelector('[data-testid="quant-limit"]')).toBeNull();

    // 填满 30 个概率
    const probInputs = container.querySelectorAll<HTMLInputElement>('input.prob-input');
    expect(probInputs.length).toBe(30);
    probInputs.forEach((input) => setNative(input, '0.5'));

    // 定量超限：显示 quantitative_limit
    const banner = container.querySelector('[data-testid="quant-limit"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('quantitative_limit');
    // 定性割集仍保留
    expect(text1()).toContain('最小割集（79 个）');
    // 不展示任何概率（顶事件概率元素不存在）
    expect(container.querySelector('[data-testid="top-probability"]')).toBeNull();
    expect(container.querySelector('[data-testid="quant-results"]')).toBeNull();

    // 输入修正：保留 30 个事件及其已填概率（概率按事件名留存），只把门定义
    // 简化为单个三元割集，定量结果应立即恢复，无需重填概率。
    const singleGate = gates.split('\n')[0]; // G00 AND ...
    setNative(areas[1], `${singleGate}\nTOP OR G00\n`);
    expect(container.querySelector('[data-testid="quant-limit"]')).toBeNull();
    const topEl = container.querySelector<HTMLInputElement>('[data-testid="top-probability"]');
    expect(topEl).not.toBeNull();
    // 三个 p=0.5 事件的 AND：P(T)=0.125
    expect(topEl!.textContent).toBe('0.125');
    // 定性割集同步变为 1 个
    expect(container.textContent).toContain('最小割集（1 个）');
  });
});
