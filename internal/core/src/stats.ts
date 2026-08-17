import { assert } from './assert.ts';

export const clamp = (value: number, lo: number, hi: number): number =>
  value < lo ? lo : value > hi ? hi : value;

export function mean(values: ArrayLike<number>, count = values.length): number {
  if (count === 0) return Number.NaN;
  let sum = 0;
  for (let i = 0; i < count; i++) sum += values[i]!;
  return sum / count;
}

export function minOf(values: ArrayLike<number>, count = values.length): number {
  if (count === 0) return Number.NaN;
  let m = values[0]!;
  for (let i = 1; i < count; i++) if (values[i]! < m) m = values[i]!;
  return m;
}

export function maxOf(values: ArrayLike<number>, count = values.length): number {
  if (count === 0) return Number.NaN;
  let m = values[0]!;
  for (let i = 1; i < count; i++) if (values[i]! > m) m = values[i]!;
  return m;
}

export function stddev(values: ArrayLike<number>, count = values.length): number {
  if (count < 2) return 0;
  const mu = mean(values, count);
  let acc = 0;
  for (let i = 0; i < count; i++) {
    const d = values[i]! - mu;
    acc += d * d;
  }
  return Math.sqrt(acc / (count - 1));
}

export function sortedCopy(values: ArrayLike<number>, count = values.length): Float64Array {
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = values[i]!;
  out.sort();
  return out;
}

/** 線性內插百分位數。`sorted` 必須已由小到大排序。 */
export function percentileFromSorted(
  sorted: ArrayLike<number>,
  p: number,
  count = sorted.length,
): number {
  if (count === 0) return Number.NaN;
  if (count === 1) return sorted[0]!;
  const rank = (count - 1) * clamp(p, 0, 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

export function percentile(values: ArrayLike<number>, p: number, count = values.length): number {
  return percentileFromSorted(sortedCopy(values, count), p, count);
}

export function median(values: ArrayLike<number>, count = values.length): number {
  return percentile(values, 0.5, count);
}

export interface Summary {
  count: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
  stddev: number;
}

/**
 * 效能報告一律以 p50 / p95 / p99 為主。
 * 平均值會把 stutter 藏起來，而 stutter 正是 shader compilation 與 streaming 的主要症狀。
 */
export function summarize(values: ArrayLike<number>, count = values.length): Summary {
  const sorted = sortedCopy(values, count);
  return {
    count,
    mean: mean(values, count),
    min: count === 0 ? Number.NaN : sorted[0]!,
    max: count === 0 ? Number.NaN : sorted[count - 1]!,
    p50: percentileFromSorted(sorted, 0.5, count),
    p95: percentileFromSorted(sorted, 0.95, count),
    p99: percentileFromSorted(sorted, 0.99, count),
    stddev: stddev(values, count),
  };
}

/** 每 N 次 push 重算一次總和，避免長時間 soak test 下的浮點漂移。 */
const RESUM_INTERVAL = 4096;

/**
 * O(1) 更新的滑動視窗平均。
 *
 * 品質調整必須基於滑動平均而非單幀數值 —— 單幀會被一次 GC 或一次
 * shader 編譯帶偏，而依那個做的調整會在下一幀立刻被推回去。
 */
export class MovingAverage {
  readonly window: number;
  private readonly buffer: Float64Array;
  private head = 0;
  private count = 0;
  private sum = 0;
  private pushes = 0;

  constructor(window: number) {
    assert(Number.isInteger(window) && window > 0, 'window 必須是正整數');
    this.window = window;
    this.buffer = new Float64Array(window);
  }

  push(value: number): number {
    if (this.count === this.window) {
      this.sum -= this.buffer[this.head]!;
    } else {
      this.count++;
    }
    this.buffer[this.head] = value;
    this.sum += value;
    const next = this.head + 1;
    this.head = next === this.window ? 0 : next;

    if (++this.pushes >= RESUM_INTERVAL) {
      this.pushes = 0;
      let s = 0;
      for (let i = 0; i < this.count; i++) s += this.buffer[i]!;
      this.sum = s;
    }
    return this.value;
  }

  get value(): number {
    return this.count === 0 ? Number.NaN : this.sum / this.count;
  }

  /** 視窗填滿前的平均值不具代表性，品質調整必須等到 warm 才能動作。 */
  get isWarm(): boolean {
    return this.count === this.window;
  }

  get size(): number {
    return this.count;
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.sum = 0;
    this.pushes = 0;
  }
}
