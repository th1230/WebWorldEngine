import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CpuProfiler } from './cpu-profiler.ts';

let clock = 0;

beforeEach(() => {
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const advance = (ms: number): void => {
  clock += ms;
};

describe('CpuProfiler', () => {
  it('returns the same id for a repeated scope name', () => {
    const p = new CpuProfiler();
    const a = p.registerScope('Physics');
    expect(p.registerScope('Physics')).toBe(a);
    expect(p.scopeCount).toBe(1);
  });

  it('accumulates time inside a scope', () => {
    const p = new CpuProfiler();
    const physics = p.registerScope('Physics');

    p.beginFrame();
    p.begin(physics);
    advance(4);
    p.end(physics);
    p.endFrame();

    expect(p.durationOf(physics)).toBeCloseTo(4, 6);
    expect(p.overflowed).toBe(false);
  });

  it('sums multiple entries into the same scope within one frame', () => {
    const p = new CpuProfiler();
    const ai = p.registerScope('AI');

    p.beginFrame();
    p.begin(ai);
    advance(2);
    p.end(ai);
    advance(10); // 不在任何 scope 內
    p.begin(ai);
    advance(3);
    p.end(ai);
    p.endFrame();

    expect(p.durationOf(ai)).toBeCloseTo(5, 6);
  });

  it('times nested scopes independently', () => {
    const p = new CpuProfiler();
    const outer = p.registerScope('Simulation');
    const inner = p.registerScope('Physics');

    p.beginFrame();
    p.begin(outer);
    advance(1);
    p.begin(inner);
    advance(5);
    p.end(inner);
    advance(1);
    p.end(outer);
    p.endFrame();

    expect(p.durationOf(inner)).toBeCloseTo(5, 6);
    expect(p.durationOf(outer)).toBeCloseTo(7, 6);
  });

  it('counts re-entrant scopes only once', () => {
    // 遞迴呼叫同一個 scope 不該讓時間被重複計算
    const p = new CpuProfiler();
    const s = p.registerScope('Recursive');

    p.beginFrame();
    p.begin(s);
    advance(2);
    p.begin(s);
    advance(3);
    p.end(s);
    advance(1);
    p.end(s);
    p.endFrame();

    expect(p.durationOf(s)).toBeCloseTo(6, 6);
  });

  it('records the whole-frame duration', () => {
    const p = new CpuProfiler();
    p.beginFrame();
    advance(16);
    p.endFrame();
    expect(p.frameMs).toBeCloseTo(16, 6);
  });

  it('clears accumulated time between frames', () => {
    const p = new CpuProfiler();
    const s = p.registerScope('Streaming');

    p.beginFrame();
    p.begin(s);
    advance(8);
    p.end(s);
    p.endFrame();

    p.beginFrame();
    p.endFrame();

    expect(p.durationOf(s)).toBe(0);
  });

  it('flags mismatched begin/end instead of silently reporting wrong numbers', () => {
    const p = new CpuProfiler();
    const a = p.registerScope('A');
    const b = p.registerScope('B');

    p.beginFrame();
    p.begin(a);
    p.end(b); // 順序錯誤
    p.endFrame();

    expect(p.overflowed).toBe(true);
  });

  it('flags an unclosed scope at end of frame', () => {
    const p = new CpuProfiler();
    const a = p.registerScope('A');

    p.beginFrame();
    p.begin(a);
    p.endFrame();

    expect(p.overflowed).toBe(true);
  });

  it('exposes durations as an indexable view for the recorder', () => {
    const p = new CpuProfiler();
    const a = p.registerScope('A');
    const b = p.registerScope('B');

    p.beginFrame();
    p.begin(a);
    advance(2);
    p.end(a);
    p.begin(b);
    advance(3);
    p.end(b);
    p.endFrame();

    expect(p.durations[a]).toBeCloseTo(2, 6);
    expect(p.durations[b]).toBeCloseTo(3, 6);
  });
});
