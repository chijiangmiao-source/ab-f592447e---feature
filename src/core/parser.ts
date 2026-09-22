import type { EventFieldInfo, Gate, Issue, ParseResult, ProbabilityStatus } from './types';

export const MIN_EVENTS = 2;
export const MAX_EVENTS = 30;
export const MIN_GATES = 1;
export const MAX_GATES = 80;

/** 独立失效概率分母：输入只接受至多六位小数，故概率精确值为 n / 1_000_000。 */
export const PROBABILITY_DENOMINATOR = 1_000_000n;

// 唯一 ASCII 标识：字母/下划线开头，后接字母数字下划线；'#' 起始为注释。
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// 0–1 的十进制、至多六位小数：
// 接受 0 / 1 / 0.5 / .5 / 0.500000 / 1.000000；
// 拒绝符号、科学计数法、多余前导零、“0.” 空小数、超过六位小数与越界值。
const PROBABILITY = /^(?:0|1|0?\.\d{1,6}|1\.0{1,6})$/;

export function isValidIdentifier(token: string): boolean {
  return IDENTIFIER.test(token);
}

/**
 * 解析概率字段原文为精确有理数（分母固定 1_000_000）。
 * 缺失（空串）按旧的“仅标识”格式处理，不构成错误；这里只判定非法与否。
 */
export function parseProbability(raw: string): {
  status: ProbabilityStatus;
  numerator?: bigint;
  reason?: string;
} {
  if (raw === '') return { status: 'missing' };
  if (!PROBABILITY.test(raw)) {
    let reason = '概率须为 0–1 的十进制数且至多六位小数（如 0.01、.5、1.000000）';
    if (/^[+-]?\d+(\.\d+)?$/.test(raw) && !Number.isNaN(Number(raw))) {
      const n = Number(raw);
      if (n < 0 || n > 1) reason = '概率须在闭区间 [0, 1] 内';
      else if (raw.includes('.') && raw.split('.')[1].length > 6) reason = '概率至多保留六位小数';
    }
    return { status: 'invalid', reason };
  }
  const dot = raw.indexOf('.');
  const intPart = dot >= 0 ? raw.slice(0, dot) : raw;
  const frac = dot >= 0 ? raw.slice(dot + 1) : '';
  const numerator =
    BigInt(intPart === '' ? 0 : intPart) * PROBABILITY_DENOMINATOR +
    BigInt((frac + '000000').slice(0, 6));
  return { status: 'valid', numerator };
}

function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return hash >= 0 ? line.slice(0, hash) : line;
}

/**
 * 解析基本事件文本：每行一个标识，可选第二字段填写独立失效概率，
 * 空行/注释允许。旧的“仅标识”行视为概率缺失——不影响定性分析，
 * 仅在全部割集已得出后阻止定量结论。
 * 保留非法行与重复行用于错误定位，不抛异常。
 */
export function parseEvents(text: string): {
  events: string[];
  issues: Issue[];
  fields: EventFieldInfo[];
} {
  const issues: Issue[] = [];
  const seen = new Map<string, number>();
  const events: string[] = [];
  const fields: EventFieldInfo[] = [];

  text.split(/\r?\n/).forEach((raw, idx) => {
    const lineNo = idx + 1;
    const token = stripComment(raw).trim();
    if (!token) return;

    const parts = token.split(/\s+/);
    const name = parts[0];
    const nameValid = isValidIdentifier(name);
    const probRaw = parts.length >= 2 ? parts[1] : '';
    let prob = parseProbability(probRaw);

    // 两个以上字段：除“概率本身非法”外，额外字段本身也是格式错误。
    if (parts.length > 2 && prob.status !== 'invalid') {
      prob = { status: 'invalid', reason: '每行至多包含“标识”与“概率”两个字段（# 之后为注释）' };
    }

    fields.push({
      line: lineNo,
      name,
      nameValid,
      probRaw,
      probStatus: prob.status,
      probReason: prob.reason,
      probNumerator: prob.numerator
    });

    if (!nameValid) {
      issues.push({
        code: 'bad_identifier',
        message: `“${raw.trim()}” 不是合法 ASCII 标识（字母/下划线开头，仅含字母数字下划线）`,
        location: { area: 'events', line: lineNo, token: raw.trim() }
      });
      return;
    }
    if (seen.has(name)) {
      issues.push({
        code: 'duplicate_event',
        message: `基本事件 ${name} 重复定义（首次出现于第 ${seen.get(name)} 行）`,
        location: { area: 'events', line: lineNo, token: name }
      });
      return;
    }
    seen.set(name, lineNo);
    events.push(name);
  });

  if (issues.length === 0 && (events.length < MIN_EVENTS || events.length > MAX_EVENTS)) {
    issues.push({
      code: 'event_count',
      message: `基本事件数量须为 ${MIN_EVENTS}–${MAX_EVENTS}，当前为 ${events.length}`,
      location: { area: 'events' }
    });
  }
  return { events, issues, fields };
}

/**
 * 解析门定义文本：每行 `名称 类型 输入1 输入2 ...`，以空白分隔，支持注释。
 * 即使部分行非法也继续解析其余行，以便一次报告尽可能多的问题。
 */
export function parseGates(text: string): { gates: Gate[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const gates: Gate[] = [];
  const seen = new Map<string, number>();

  text.split(/\r?\n/).forEach((raw, idx) => {
    const lineNo = idx + 1;
    const line = stripComment(raw).trim();
    if (!line) return;

    const parts = line.split(/\s+/);
    if (parts.length < 3) {
      issues.push({
        code: 'malformed_gate_line',
        message: `门定义格式应为 “名称 AND|OR 输入...”，第 ${lineNo} 行字段不足`,
        location: { area: 'gates', line: lineNo, token: raw.trim() }
      });
      return;
    }

    const [name, typeToken, ...inputs] = parts;
    if (!isValidIdentifier(name)) {
      issues.push({
        code: 'bad_identifier',
        message: `门名称 “${name}” 不是合法 ASCII 标识`,
        location: { area: 'gates', line: lineNo, token: name }
      });
      return;
    }
    if (typeToken !== 'AND' && typeToken !== 'OR') {
      issues.push({
        code: 'unknown_gate_type',
        message: `门 ${name} 的类型 “${typeToken}” 非法，仅允许 AND 或 OR`,
        location: { area: 'gates', line: lineNo, token: typeToken }
      });
      return;
    }

    const badInput = inputs.find((t) => !isValidIdentifier(t));
    if (badInput) {
      issues.push({
        code: 'bad_identifier',
        message: `门 ${name} 的输入 “${badInput}” 不是合法 ASCII 标识`,
        location: { area: 'gates', line: lineNo, token: badInput }
      });
      return;
    }
    if (inputs.length === 0) {
      // 语法上 parts.length>=3 时不会发生，保留防御分支。
      issues.push({
        code: 'empty_inputs',
        message: `门 ${name} 至少需要一个输入`,
        location: { area: 'gates', line: lineNo, token: name }
      });
      return;
    }

    if (seen.has(name)) {
      issues.push({
        code: 'duplicate_gate',
        message: `门 ${name} 重复定义（首次出现于第 ${seen.get(name)} 行）`,
        location: { area: 'gates', line: lineNo, token: name }
      });
      return;
    }
    seen.set(name, lineNo);
    gates.push({ name, type: typeToken, inputs, line: lineNo });
  });

  if (issues.length === 0 && (gates.length < MIN_GATES || gates.length > MAX_GATES)) {
    issues.push({
      code: 'gate_count',
      message: `门数量须为 ${MIN_GATES}–${MAX_GATES}，当前为 ${gates.length}`,
      location: { area: 'gates' }
    });
  }
  return { gates, issues };
}

export function parseTop(text: string): { top: string; issues: Issue[] } {
  const issues: Issue[] = [];
  const token = stripComment(text).trim();
  if (!token) {
    issues.push({
      code: 'top_invalid',
      message: '必须指定一个顶事件（门名称）',
      location: { area: 'top' }
    });
  } else if (token.split(/\s+/).length > 1 || !isValidIdentifier(token)) {
    issues.push({
      code: 'top_invalid',
      message: `顶事件必须是单个合法 ASCII 标识，当前为 “${token}”`,
      location: { area: 'top', token }
    });
  }
  return { top: token, issues };
}

export function parseModel(eventsText: string, gatesText: string, topText: string): ParseResult {
  const { events, issues: eIssues, fields } = parseEvents(eventsText);
  const { gates, issues: gIssues } = parseGates(gatesText);
  const { top, issues: tIssues } = parseTop(topText);
  return {
    model: { events, gates, top },
    issues: [...eIssues, ...gIssues, ...tIssues],
    eventFields: fields
  };
}
