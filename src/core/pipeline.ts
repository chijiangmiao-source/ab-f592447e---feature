import { analyze } from './engine';
import { parseModel } from './parser';
import type { Analysis, EventFieldInfo } from './types';
import { validate } from './validate';

export interface AuditOutput {
  analysis: Analysis;
  /** 事件行字段（含概率列）解析信息，供定量复核与行级提示使用 */
  eventFields: EventFieldInfo[];
}

/** 总入口：解析 → 结构校验（缺失引用/自引用/环）→ 精确割集分析。 */
export function auditDetailed(eventsText: string, gatesText: string, topText: string): AuditOutput {
  const { model, issues: parseIssues, eventFields } = parseModel(eventsText, gatesText, topText);
  // 即使存在解析问题，也基于已成功解析的部分继续做结构诊断，
  // 从而一次性定位尽可能多的问题；非法原文仍保留在编辑器中。
  // 注意：概率字段缺失/非法不属于定性问题，不进入 issues，不阻止割集结论。
  const structuralIssues = validate(model);
  const allIssues = [...parseIssues, ...structuralIssues].sort((a, b) => {
    const areaOrder = { events: 0, gates: 1, top: 2 } as const;
    if (areaOrder[a.location.area] !== areaOrder[b.location.area]) {
      return areaOrder[a.location.area] - areaOrder[b.location.area];
    }
    return (a.location.line ?? 0) - (b.location.line ?? 0);
  });
  if (allIssues.length > 0) {
    return { analysis: { status: 'invalid', issues: allIssues }, eventFields };
  }
  return { analysis: analyze(model), eventFields };
}

/** 兼容旧调用方：仅取定性分析结论。 */
export function audit(eventsText: string, gatesText: string, topText: string): Analysis {
  return auditDetailed(eventsText, gatesText, topText).analysis;
}
