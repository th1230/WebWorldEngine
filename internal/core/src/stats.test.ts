import { describe, expect, it } from 'vitest';
import { MovingAverage, mean, percentile, sortedCopy, stddev, summarize } from './stats.ts';

describe('percentile', () => {
  it('interpolates linearly between neighbours', () => {
    const values = [1, 2, 3, 4];
    // rank = (4-1) * 0.5 = 1.5 → 介於 values[1]=2 與 values[2]=3 之間
    expect(percentile(values, 0.5)).toBeCloseTo(2.5, 10);
  });

  it('returns the endpoints for p=0 and p=1', () => {
    const values = [5, 1, 9, 3];
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 1)).toBe(9);
  });

  it('clamps p outside [0,1] rather than reading out of bounds', () => {
    const values = [1, 2, 3];
    expect(percentile(values, -1)).toBe(1);
    expect(percentile(values, 2)).toBe(3);
  });

  it('handles empty and single-element input', () => {
    expect(percentile([], 0.5)).toBeNaN();
    expect(percentile([42], 0.95)).toBe(42);
  });

  it('sorts numerically, not lexicographically', () => {
    // Array.prototype.sort() 會把 [10, 9] 排成 [10, 9]；TypedArray.sort() 不會。
    expect(Array.from(sortedCopy([10, 9, 100, 2]))).toEqual([2, 9, 10, 100]);
    expect(percentile([10, 9, 100, 2], 1)).toBe(100);
  });

  it('honours an explicit count so callers can pass oversized buffers', () => {
    const buffer = new Float64Array([1, 2, 3, 0, 0, 0]);
    expect(percentile(buffer, 1, 3)).toBe(3);
    expect(mean(buffer, 3)).toBe(2);
  });
});

describe('summarize', () => {
  it('reports p50/p95/p99 alongside mean', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const s = summarize(values);
    expect(s.count).toBe(100);
    expect(s.min).toBe(1);
    expect(s.max).toBe(100);
    expect(s.mean).toBeCloseTo(50.5, 10);
    expect(s.p50).toBeCloseTo(50.5, 10);
    expect(s.p95).toBeCloseTo(95.05, 10);
  });

  it('exposes the stutter that mean hides', () => {
    // 95 幀 16ms + 5 幀 500ms —— shader 編譯造成的卡頓大概就長這樣。
    // 平均值 40ms 看起來只是「有點慢」；p99 才顯示出真的有半秒級的停頓。
    const values = [
      ...Array.from({ length: 95 }, () => 16),
      ...Array.from({ length: 5 }, () => 500),
    ];
    const s = summarize(values);

    expect(s.p50).toBe(16);
    expect(s.mean).toBeCloseTo(40.2, 6);
    expect(s.p99).toBe(500);
  });

  it('does not let a lone outlier dominate p99', () => {
    // 反過來也要成立：100 幀裡只有 1 幀爆掉時，p99 不該被拉到極端值，
    // 否則回歸門檻會被單一雜訊幀觸發。這就是為什麼報告同時保留 p99 與 max。
    const values = [...Array.from({ length: 99 }, () => 16), 500];
    const s = summarize(values);

    expect(s.p99).toBeLessThan(25);
    expect(s.max).toBe(500);
  });
});

describe('stddev', () => {
  it('uses the sample (n-1) denominator', () => {
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 4);
  });

  it('returns 0 for fewer than two samples', () => {
    expect(stddev([])).toBe(0);
    expect(stddev([5])).toBe(0);
  });
});

describe('MovingAverage', () => {
  it('averages only the values seen so far before the window fills', () => {
    const ma = new MovingAverage(4);
    expect(ma.value).toBeNaN();
    expect(ma.isWarm).toBe(false);

    ma.push(10);
    ma.push(20);
    expect(ma.value).toBe(15);
    expect(ma.isWarm).toBe(false);
  });

  it('becomes warm exactly when the window is full', () => {
    const ma = new MovingAverage(3);
    ma.push(1);
    ma.push(2);
    expect(ma.isWarm).toBe(false);
    ma.push(3);
    expect(ma.isWarm).toBe(true);
    expect(ma.value).toBe(2);
  });

  it('slides the window, dropping the oldest sample', () => {
    const ma = new MovingAverage(3);
    for (const v of [1, 2, 3, 4, 5]) ma.push(v);
    expect(ma.value).toBe(4); // (3+4+5)/3
  });

  it('stays accurate over a long soak run despite float drift', () => {
    const ma = new MovingAverage(60);
    // 遠超過 RESUM_INTERVAL，確保週期性重算有生效
    for (let i = 0; i < 50_000; i++) ma.push(16.6666666);
    expect(ma.value).toBeCloseTo(16.6666666, 9);

    for (let i = 0; i < 60; i++) ma.push(33.3333333);
    expect(ma.value).toBeCloseTo(33.3333333, 9);
  });

  it('resets back to empty', () => {
    const ma = new MovingAverage(3);
    ma.push(1);
    ma.push(2);
    ma.reset();
    expect(ma.value).toBeNaN();
    expect(ma.size).toBe(0);
  });

  it('rejects an invalid window', () => {
    expect(() => new MovingAverage(0)).toThrow();
    expect(() => new MovingAverage(2.5)).toThrow();
  });
});
