import type { Issue, ParsedModel } from './types';

/**
 * 结构性校验：
 * - 门名不得与基本事件冲突
 * - 顶事件必须引用一个已定义的门
 * - 门输入必须解析到基本事件或门（缺失引用）
 * - 自引用单独定位
 * - 门间引用不得含环（Tarjan SCC，支持任意长度的环）
 * 返回的问题列表按定位区域/行号排序，非法输入原样保留在 UI 中。
 */
export function validate(model: ParsedModel): Issue[] {
  const issues: Issue[] = [];
  const eventSet = new Set(model.events);
  const gateByName = new Map<string, number>();
  model.gates.forEach((g, i) => gateByName.set(g.name, i));

  for (const g of model.gates) {
    if (eventSet.has(g.name)) {
      issues.push({
        code: 'name_collision',
        message: `门 ${g.name} 与基本事件同名，事件与门必须共享同一命名空间且唯一`,
        location: { area: 'gates', line: g.line, token: g.name }
      });
    }
  }

  if (model.top && !gateByName.has(model.top)) {
    issues.push({
      code: 'top_not_gate',
      message: `顶事件 ${model.top} 不是已定义的门`,
      location: { area: 'top', token: model.top }
    });
  }

  for (const g of model.gates) {
    const uniqueInputs = new Set<string>();
    for (const input of g.inputs) {
      uniqueInputs.add(input);
      if (input === g.name) {
        issues.push({
          code: 'self_reference',
          message: `门 ${g.name} 第 ${g.line} 行直接引用自身`,
          location: { area: 'gates', line: g.line, token: g.name }
        });
      } else if (!eventSet.has(input) && !gateByName.has(input)) {
        issues.push({
          code: 'missing_reference',
          message: `门 ${g.name} 引用的 “${input}” 既不是基本事件也不是已定义的门`,
          location: { area: 'gates', line: g.line, token: input }
        });
      }
    }
  }

  // 门级图：缺失目标不是门，自环由 self_reference 负责，二者都不进入环搜索。
  const adjacency = new Map<string, string[]>();
  for (const g of model.gates) {
    const next = g.inputs.filter((i) => i !== g.name && gateByName.has(i));
    adjacency.set(g.name, [...new Set(next)]);
  }

  for (const cycle of findCycles(adjacency)) {
    issues.push({
      code: 'cycle',
      message: `门引用存在环：${cycle.join(' → ')} → ${cycle[0]}（共享 DAG 不允许环路）`,
      location: { area: 'gates', line: gateLine(model, cycle[0]), token: cycle[0] }
    });
  }

  issues.sort((a, b) => {
    const areaOrder = { events: 0, gates: 1, top: 2 } as const;
    if (areaOrder[a.location.area] !== areaOrder[b.location.area]) {
      return areaOrder[a.location.area] - areaOrder[b.location.area];
    }
    return (a.location.line ?? 0) - (b.location.line ?? 0);
  });
  return issues;
}

function gateLine(model: ParsedModel, name: string): number | undefined {
  return model.gates.find((g) => g.name === name)?.line;
}

/**
 * Tarjan 强连通分量。门数量上限 80，递归安全。
 * 返回每个非平凡 SCC 内的一条具体环路径（用于定位，任意长度均可）。
 */
export function findCycles(adjacency: Map<string, string[]>): string[][] {
  let indexCounter = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  const strongConnect = (v: string): void => {
    index.set(v, indexCounter);
    lowlink.set(v, indexCounter);
    indexCounter += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) ?? []) {
      if (!index.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) sccs.push(component);
    }
  };

  for (const v of [...adjacency.keys()].sort()) {
    if (!index.has(v)) strongConnect(v);
  }

  return sccs.map((scc) => cycleInComponent(new Set(scc), adjacency)).sort((a, b) => a.join('~').localeCompare(b.join('~')));
}

/** 在一个非平凡 SCC 的受限子图中走出一条具体环。 */
function cycleInComponent(nodes: Set<string>, adjacency: Map<string, string[]>): string[] {
  const start = [...nodes].sort()[0];
  const path: string[] = [];
  const pos = new Map<string, number>();
  let current = start;

  while (!pos.has(current)) {
    pos.set(current, path.length);
    path.push(current);
    current = adjacency.get(current)!.filter((n) => nodes.has(n)).sort()[0];
  }
  return path.slice(pos.get(current)!);
}
