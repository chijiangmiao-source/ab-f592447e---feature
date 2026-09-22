// 故障树核心数据模型 —— 全部为纯数据结构，计算仅发生在浏览器内。

export type GateType = 'AND' | 'OR';

export interface Gate {
  name: string;
  type: GateType;
  /** 输入标识（基本事件或其他门），保留重复值由分析阶段去重 */
  inputs: string[];
  /** 在门定义文本中的行号（1 起） */
  line: number;
}

export type Area = 'events' | 'gates' | 'top';

export interface IssueLocation {
  area: Area;
  /** 文本域内行号（1 起，top 无行号） */
  line?: number;
  /** 相关标识，便于定位 */
  token?: string;
}

export interface Issue {
  code:
    | 'bad_identifier'
    | 'duplicate_event'
    | 'event_count'
    | 'duplicate_gate'
    | 'gate_count'
    | 'malformed_gate_line'
    | 'unknown_gate_type'
    | 'empty_inputs'
    | 'name_collision'
    | 'missing_reference'
    | 'self_reference'
    | 'cycle'
    | 'top_invalid'
    | 'top_not_gate';
  message: string;
  location: IssueLocation;
}

export interface ParsedModel {
  events: string[];
  gates: Gate[];
  top: string;
}

/** 事件行第二字段（独立失效概率）的解析状态；缺失等同于旧的“仅标识”格式。 */
export type ProbabilityStatus = 'missing' | 'valid' | 'invalid';

export interface EventFieldInfo {
  /** 在基本事件文本中的行号（1 起） */
  line: number;
  /** 行首标识原文（可能非法，非法时 nameValid=false） */
  name: string;
  nameValid: boolean;
  /** 概率字段原文（trim 后）；缺失为 '' */
  probRaw: string;
  probStatus: ProbabilityStatus;
  /** 非法时的人类可读原因 */
  probReason?: string;
  /** 有效概率的分子，分母固定为 1_000_000（六位小数） */
  probNumerator?: bigint;
}

export interface ParseResult {
  model: ParsedModel;
  issues: Issue[];
  /** 每个非空事件行的字段解析信息（含概率字段）；不影响定性分析的合法性判定。 */
  eventFields: EventFieldInfo[];
}

export type EventRole = 'mandatory' | 'optional' | 'irrelevant';

export interface CompleteAnalysis {
  status: 'complete';
  top: string;
  /** 顶事件最小割集，集合内与集合间均按事件标识排序 */
  cutsets: string[][];
  /** 基本事件归属：必现 / 可选 / 无关 */
  classification: Record<string, EventRole>;
  /** 每个门规范化后的割集数量（审计用） */
  gateCounts: Record<string, number>;
}

export interface LimitedAnalysis {
  status: 'complexity_limit';
  /** 首个越过限制的门 */
  gate: string;
  line: number;
  limit: number;
  /** 触发限制前已完成的门计数，仅供参考，严禁作为完整结论 */
  partialGateCounts: Record<string, number>;
}

export interface InvalidAnalysis {
  status: 'invalid';
  issues: Issue[];
}

export type Analysis = CompleteAnalysis | LimitedAnalysis | InvalidAnalysis;

/** 精确有理数值（BigInt）及其有限十进制表示（分母只含因子 2、5，十进制必然终止）。 */
export interface ProbValue {
  numerator: bigint;
  denominator: bigint;
  /** 精确十进制字符串（不含指数，去掉尾随零） */
  decimal: string;
}

export interface ProbabilityProblem {
  line: number;
  name: string;
  raw: string;
  kind: 'missing' | 'invalid';
  reason?: string;
}

export interface EventQuantitative {
  event: string;
  line: number;
  /** 用户输入的概率原文 */
  input: string;
  p: ProbValue;
  /** 强制该事件“未发生”后的顶事件条件概率 P(T|e=0) */
  absent: ProbValue;
  /** 强制该事件“已发生”后的顶事件条件概率 P(T|e=1) */
  present: ProbValue;
  /** 差值 P(T|e=1) − P(T|e=0)（单调故障树中非负） */
  delta: ProbValue;
  /** 精确一致性：P(T) = (1−p)·P(T|e=0) + p·P(T|e=1) */
  identityHolds: boolean;
  /** 精确偏序：P(T|e=0) ≤ P(T) ≤ P(T|e=1) */
  orderHolds: boolean;
}

export type QuantitativeResult =
  | { status: 'quant_ok'; top: ProbValue; events: EventQuantitative[]; nodes: number }
  | { status: 'quantitative_limit'; limit: number; nodes: number }
  | { status: 'prob_invalid'; problems: ProbabilityProblem[] };
