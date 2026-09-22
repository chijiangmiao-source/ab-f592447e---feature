// 精确十进制运算：定量复核的全部数值都基于 bigint，
// 不经过 IEEE-754 浮点，保证按用户输入十进制的精确值计算（含共享割集去重）。
// 整个定量过程只做加 / 减 / 乘，因此结果始终是有限小数。

function normalize(coef: bigint, scale: number): { coef: bigint; scale: number } {
  let c = coef;
  let s = scale;
  if (c === 0n) return { coef: 0n, scale: 0 };
  while (s > 0 && c % 10n === 0n) {
    c /= 10n;
    s -= 1;
  }
  return { coef: c, scale: s };
}

/**
 * 有限小数：value = coef / 10^scale，coef >= 0，末尾的零已消去。
 */
export class Decimal {
  readonly coef: bigint;
  readonly scale: number;

  private constructor(coef: bigint, scale: number) {
    this.coef = coef;
    this.scale = scale;
  }

  static readonly ZERO = new Decimal(0n, 0);
  static readonly ONE = new Decimal(1n, 0);

  static fromCoef(coef: bigint, scale: number): Decimal {
    const n = normalize(coef, scale);
    if (n.coef === 0n) return Decimal.ZERO;
    if (n.coef === 1n && n.scale === 0) return Decimal.ONE;
    return new Decimal(n.coef, n.scale);
  }

  get isZero(): boolean {
    return this.coef === 0n;
  }

  get isOne(): boolean {
    return this.coef === 1n && this.scale === 0;
  }

  private scaleTo(other: Decimal): { a: bigint; b: bigint; scale: number } {
    const scale = Math.max(this.scale, other.scale);
    return {
      a: this.coef * 10n ** BigInt(scale - this.scale),
      b: other.coef * 10n ** BigInt(scale - other.scale),
      scale
    };
  }

  add(other: Decimal): Decimal {
    const { a, b, scale } = this.scaleTo(other);
    return Decimal.fromCoef(a + b, scale);
  }

  /** 调用方保证 this >= other（单调故障树的概率扣除/差值）。 */
  sub(other: Decimal): Decimal {
    const { a, b, scale } = this.scaleTo(other);
    return Decimal.fromCoef(a - b, scale);
  }

  mul(other: Decimal): Decimal {
    return Decimal.fromCoef(this.coef * other.coef, this.scale + other.scale);
  }

  equals(other: Decimal): boolean {
    return this.coef === other.coef && this.scale === other.scale;
  }

  /** 精确有限小数字符串，不做任何舍入；位数可能很长。 */
  toString(): string {
    if (this.scale === 0) return this.coef.toString();
    const s = this.coef.toString().padStart(this.scale + 1, '0');
    return `${s.slice(0, -this.scale)}.${s.slice(-this.scale)}`;
  }
}
