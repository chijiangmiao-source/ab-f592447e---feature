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
});

describe('App 定量复核', () => {
  const PROB_EVENTS = 'A 0.1\nB 0.2\n';
  const GATES_AB = 'T OR A B\n';

  it('旧的仅标识格式：定性完整，定量显示缺失列表且无概率', () => {
    const { container } = render();
    const areas = container.querySelectorAll('textarea');
    setNative(areas[0], 'A\nB\n');
    setNative(areas[1], GATES_AB);
    setNative(container.querySelector('input')!, 'T');
    const text = container.textContent ?? '';
    expect(text).toContain('最小割集（2 个）');
    expect(text).toContain('定量结论暂不可用');
    expect(text).toContain('缺失');
    // 不允许出现任何概率数值结论
    expect(text).not.toContain('（精确值）');
  });

  it('非法概率保留原文、只阻止定量；修正后立即恢复精确概率', () => {
    const { container } = render();
    const areas = container.querySelectorAll('textarea');
    setNative(areas[0], 'A 0.1\nB 1.2\n');
    setNative(areas[1], GATES_AB);
    setNative(container.querySelector('input')!, 'T');
    let text = container.textContent ?? '';
    expect(text).toContain('最小割集（2 个）'); // 定性不受影响
    expect(text).toContain('非法');
    expect(text).toContain('1.2');
    expect(text).not.toContain('（精确值）');

    setNative(areas[0], 'A 0.1\nB 0.2\n');
    text = container.textContent ?? '';
    expect(text).toContain('（精确值）');
    expect(text).toContain('0.28'); // 精确：0.1+0.2-0.02，非互斥相加的 0.3
    expect(text).toContain('全概率分解');
  });

  it('选择事件后联动高亮受影响割集并显示干预核对', () => {
    const { container } = render();
    const areas = container.querySelectorAll('textarea');
    setNative(areas[0], PROB_EVENTS);
    setNative(areas[1], GATES_AB);
    setNative(container.querySelector('input')!, 'T');

    const chip = [...container.querySelectorAll('button.chip-btn')].find((b) => b.textContent === 'A') as HTMLButtonElement;
    act(() => chip.click());
    const hit = container.querySelectorAll('.cutset-hit');
    expect(hit.length).toBe(1); // 仅割集 {A}
    expect(hit[0].textContent).toContain('A');
    const dimmed = container.querySelectorAll('.cutset-dim');
    expect(dimmed.length).toBe(1); // {B} 变暗
    const text = container.textContent ?? '';
    expect(text).toContain('受影响解释 1/2');
    expect(text).toContain('事件 A 的干预核对');
    expect(text).toContain('0.2'); // P(T|A=0)=pB
  });

  it('概率为 0 与 1 的边界输入可正常定量', () => {
    const { container } = render();
    const areas = container.querySelectorAll('textarea');
    setNative(areas[0], 'A 0\nB 1\n');
    setNative(areas[1], GATES_AB);
    setNative(container.querySelector('input')!, 'T');
    const text = container.textContent ?? '';
    expect(text).toContain('（精确值）');
    // 顶事件必发生：顶事件概率值精确定格为 1
    expect(container.querySelector('.top-prob-value')!.textContent).toBe('1');
  });

  it('压力示例显示 quantitative_limit、保留割集，切到全 0 后恢复', () => {
    const { container } = render();
    const buttons = [...container.querySelectorAll('button')];
    act(() => (buttons.find((b) => b.textContent!.includes('触发定量上限')) as HTMLButtonElement).click());

    let text = container.textContent ?? '';
    expect(text).toContain('quantitative_limit');
    expect(text).toContain('最小割集（78 个）'); // 定性割集保留
    expect(text).not.toContain('（精确值）'); // 不展示部分概率

    const again = [...container.querySelectorAll('button')];
    act(() => (again.find((b) => b.textContent!.includes('概率全 0')) as HTMLButtonElement).click());
    text = container.textContent ?? '';
    expect(text).toContain('（精确值）');
    expect(container.querySelector('.top-prob-value')!.textContent).toBe('0');
    expect(text).not.toContain('quantitative_limit');
  });
});
