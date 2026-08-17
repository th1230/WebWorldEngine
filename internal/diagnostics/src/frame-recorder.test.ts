import { describe, expect, it } from 'vitest';
import { FrameRecorder, type FrameInput } from './frame-recorder.ts';
import { EMPTY_STATS } from './telemetry.ts';

function frame(overrides: Partial<FrameInput> & { memoryTotalBytes?: number } = {}): FrameInput {
  const { memoryTotalBytes, ...rest } = overrides;
  return {
    frameId: 0,
    deltaMs: 16,
    cpuFrameMs: 4,
    longTaskMs: 0,
    jsHeapUsedBytes: null,
    stats: { ...EMPTY_STATS, memoryTotalBytes: memoryTotalBytes ?? 1000 },
    ...rest,
  };
}

describe('FrameRecorder scope buffers', () => {
  it('drops nothing when scopes are registered after construction', () => {
    // 這是曾經存在的靜默 bug：晚註冊的 scope 沒有對應序列，時間會被無聲丟棄。
    const r = new FrameRecorder({ historyFrames: 10, scopeCount: 1 });
    expect(r.scopeCount).toBe(1);

    r.ensureScopes(3);
    expect(r.scopeCount).toBe(3);

    r.record(frame(), [1, 2, 3]);
    expect(r.scopeSummary(0).p50).toBe(1);
    expect(r.scopeSummary(1).p50).toBe(2);
    expect(r.scopeSummary(2).p50).toBe(3);
  });

  it('never shrinks the scope count', () => {
    const r = new FrameRecorder({ historyFrames: 10, scopeCount: 3 });
    r.ensureScopes(1);
    expect(r.scopeCount).toBe(3);
  });

  it('returns an empty summary for an unknown scope index', () => {
    const r = new FrameRecorder({ historyFrames: 10, scopeCount: 1 });
    expect(r.scopeSummary(99).count).toBe(0);
  });
});

describe('FrameRecorder early-frame window', () => {
  it('survives the ring buffer wrapping around', () => {
    // 歷史只有 8 幀，但開頭視窗必須完整保留最初的資料
    const r = new FrameRecorder({ historyFrames: 8 });
    r.record(frame({ deltaMs: 500, cpuFrameMs: 120 }), []);
    for (let i = 0; i < 200; i++) r.record(frame({ deltaMs: 16, cpuFrameMs: 4 }), []);

    const early = r.earlyFrames();
    expect(r.size).toBe(8); // 歷史已經繞回去了
    expect(early.worstMs).toBe(500); // 開頭那一幀還在
    expect(early.worstCpuMs).toBe(120);
  });

  it('caps the window and sums only what it captured', () => {
    const r = new FrameRecorder({ historyFrames: 200 });
    for (let i = 0; i < 100; i++) r.record(frame({ deltaMs: 10 }), []);

    const early = r.earlyFrames();
    expect(early.count).toBe(30);
    expect(early.totalMs).toBeCloseTo(300, 6);
  });

  it('reports zeroes before any frame is recorded', () => {
    const early = new FrameRecorder().earlyFrames();
    expect(early).toEqual({ count: 0, totalMs: 0, worstMs: 0, worstCpuMs: 0 });
  });

  it('restarts the window on clear so warm-up frames are excluded', () => {
    const r = new FrameRecorder({ historyFrames: 100 });
    r.record(frame({ deltaMs: 900 }), []); // 暖機時的慢幀
    r.clear();
    r.record(frame({ deltaMs: 16 }), []);

    expect(r.earlyFrames().worstMs).toBe(16);
  });
});

describe('FrameRecorder memory drift', () => {
  const MB = 1024 * 1024;

  it('reports no drift for a stable scene', () => {
    const r = new FrameRecorder({ historyFrames: 200 });
    for (let i = 0; i < 100; i++) r.record(frame({ memoryTotalBytes: 50 * MB }), []);
    expect(r.memoryDriftBytes()).toBe(0);
  });

  it('detects monotonic growth', () => {
    // 每幀多 1MB，100 幀後後段平均會明顯高於前段
    const r = new FrameRecorder({ historyFrames: 200 });
    for (let i = 0; i < 100; i++) r.record(frame({ memoryTotalBytes: i * MB }), []);
    expect(r.memoryDriftBytes() / MB).toBeGreaterThan(50);
  });

  it('reports negative drift when memory is released', () => {
    const r = new FrameRecorder({ historyFrames: 200 });
    for (let i = 0; i < 100; i++) r.record(frame({ memoryTotalBytes: (100 - i) * MB }), []);
    expect(r.memoryDriftBytes()).toBeLessThan(0);
  });

  it('stays silent instead of guessing on too few samples', () => {
    const r = new FrameRecorder({ historyFrames: 200 });
    for (let i = 0; i < 4; i++) r.record(frame({ memoryTotalBytes: i * MB }), []);
    expect(r.memoryDriftBytes()).toBe(0);
  });
});

describe('FrameRecorder peak memory', () => {
  it('remembers the peak even after the value drops out of history', () => {
    const r = new FrameRecorder({ historyFrames: 4 });
    r.record(frame({ memoryTotalBytes: 999 }), []);
    for (let i = 0; i < 20; i++) r.record(frame({ memoryTotalBytes: 10 }), []);
    expect(r.peakMemoryBytes).toBe(999);
  });

  it('resets the peak on clear', () => {
    const r = new FrameRecorder({ historyFrames: 4 });
    r.record(frame({ memoryTotalBytes: 999 }), []);
    r.clear();
    expect(r.peakMemoryBytes).toBe(0);
  });
});
