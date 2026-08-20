import type { Summary } from '@ww/core';
import { REPORT_SCHEMA_VERSION, type BenchmarkReport } from '@ww/diagnostics';
import { describe, expect, it } from 'vitest';
import { analyzeVariance, formatVariance, spearmanTrend } from './variance.ts';

describe('spearmanTrend', () => {
  it('returns +1 for a strictly increasing sequence', () => {
    expect(spearmanTrend([1, 2, 3, 4, 5])).toBeCloseTo(1, 6);
  });

  it('returns -1 for a strictly decreasing sequence', () => {
    expect(spearmanTrend([5, 4, 3, 2, 1])).toBeCloseTo(-1, 6);
  });

  it('returns near zero for scatter with no direction', () => {
    expect(Math.abs(spearmanTrend([3, 1, 4, 1, 3]))).toBeLessThan(0.6);
  });

  it('handles ties without blowing up', () => {
    expect(Number.isFinite(spearmanTrend([2, 2, 2, 2, 2]))).toBe(true);
  });

  it('needs at least three samples to claim a trend', () => {
    expect(spearmanTrend([1, 9])).toBe(0);
  });
});

function summary(p95: number): Summary {
  return { count: 100, mean: p95, min: p95, max: p95, p50: p95, p95, p99: p95, stddev: 0 };
}

function report(scene: string, frameP95: number, gpuP95 = 10): BenchmarkReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    engineVersion: 'test',
    scene,
    params: {},
    machineId: 'm1',
    cpuReferenceMs: 100,
    memoryReferenceMs: 50,
    platform: {
      backend: 'webgpu',
      tier: 3,
      tierReasons: [],
      adapter: {
        vendor: '',
        architecture: '',
        device: '',
        description: '',
        isFallbackAdapter: false,
      },
      timestampsAvailable: true,
      userAgent: 'test',
      devicePixelRatio: 1,
      viewportWidth: 1280,
      viewportHeight: 720,
    },
    notes: [],
    verdict: null,
    capturedAt: '2026-08-15T00:00:00.000Z',
    frames: 600,
    timing: {
      deltaMs: summary(frameP95),
      cpuFrameMs: summary(4),
      gpuRenderMs: summary(gpuP95),
      gpuSampleCount: 150,
      fpsP50: 1000 / frameP95,
      fpsP1Low: 1000 / frameP95,
    },
    scopes: {},
    counters: { drawCalls: summary(10), triangles: summary(1000) },
    earlyFrames: { count: 30, totalMs: 480, worstMs: 20, worstCpuMs: 5 },
    memory: {
      totalBytes: summary(1024),
      peakTotalBytes: 100 * 1024 * 1024,
      jsHeapPeakBytes: null,
      driftBytes: 0,
    },
    mainThread: { longTaskObservationSupported: true, longTasks: 0, longTaskMs: 0 },
  };
}

describe('analyzeVariance', () => {
  it('refuses to derive a threshold from a single run', () => {
    const result = analyzeVariance([[report('a', 16)]]);
    expect(result.rows).toHaveLength(0);
    expect(result.warnings.join()).toContain('兩次');
  });

  it('suggests the floor when every run is identical', () => {
    const runs = [[report('a', 16)], [report('a', 16)], [report('a', 16)], [report('a', 16)]];
    const result = analyzeVariance(runs);

    expect(result.worst?.maxDeviationPct).toBe(0);
    expect(result.suggestedThresholdPct).toBe(10); // 下限
  });

  it('derives the threshold from the worst deviation with a safety factor', () => {
    // 中位數 20，最大偏離 |24-20|/20 = 20% → 20 × 2 = 40%
    const runs = [[report('a', 16)], [report('a', 20)], [report('a', 24)], [report('a', 20)]];
    const result = analyzeVariance(runs);

    expect(result.worst?.maxDeviationPct).toBeCloseTo(20, 6);
    expect(result.suggestedThresholdPct).toBe(40);
  });

  it('rounds the suggestion up to a multiple of five', () => {
    // 中位數 100，最大偏離 7% → 14% → 進位到 15%
    const runs = [[report('a', 100)], [report('a', 107)], [report('a', 100)], [report('a', 96)]];
    const result = analyzeVariance(runs);

    expect(result.suggestedThresholdPct).toBe(15);
  });

  it('ignores metrics below their noise floor', () => {
    // frame p95 只有 0.5ms，遠低於 1.0 的下限；它的百分比是計時器量化誤差
    const runs = [[report('a', 0.4)], [report('a', 0.9)], [report('a', 0.5)]];
    const result = analyzeVariance(runs);

    expect(result.rows.some((r) => r.metric === 'frameMs.p95')).toBe(false);
  });

  it('separates monotonic drift from random scatter', () => {
    // 實際遇到的情況：GPU 時間一路從 7.2 爬到 9.6。這是散熱累積，不是雜訊；
    // 把它算進門檻推導會得出「建議 70%」這種讓閘門失效的答案。
    const runs = [7.2, 7.2, 7.3, 8.6, 9.6].map((gpu) => [report('drifty', 16, gpu)]);
    const result = analyzeVariance(runs);

    const row = result.rows.find((r) => r.metric === 'gpuRenderMs.p95')!;
    expect(row.drifting).toBe(true);
    expect(row.trend).toBeGreaterThan(0.9);
    // 斷言「哪些項漂移」而不是「幾項漂移」：後者會在新增指標時
    // 無意義地失敗，而那正是剛才發生的事（加了 gpuRenderMs.p50）。
    expect(result.drifting.map((r) => r.metric)).toContain('gpuRenderMs.p95');
    expect(result.drifting.map((r) => r.metric)).not.toContain('frameMs.p95');
    expect(result.warnings.join()).toContain('漂移');
  });

  it('excludes drifting metrics from the threshold derivation', () => {
    // 一項漂移 30%、一項散布 5% → 門檻應該來自後者
    const gpus = [7.2, 7.2, 7.3, 8.6, 9.6];
    const frames = [16, 16.8, 16.2, 16.5, 16.1];
    const runs = gpus.map((gpu, i) => [report('mixed', frames[i]!, gpu)]);
    const result = analyzeVariance(runs);

    expect(result.worst?.metric).not.toBe('gpuRenderMs.p95');
    expect(result.suggestedThresholdPct).toBeLessThanOrEqual(15);
  });

  it('does not flag a tiny monotonic change as drift', () => {
    // 單調但只差 0.6%，沒有實務意義
    const runs = [16.0, 16.02, 16.04, 16.06, 16.08].map((f) => [report('a', f)]);
    expect(analyzeVariance(runs).drifting).toHaveLength(0);
  });

  it('reports the worst scene and metric by name', () => {
    const runs = [
      [report('quiet', 16, 10), report('noisy', 16, 10)],
      [report('quiet', 16, 10), report('noisy', 30, 10)],
      [report('quiet', 16, 10), report('noisy', 16, 10)],
    ];
    const result = analyzeVariance(runs);

    expect(result.worst?.scene).toBe('noisy');
    expect(result.worst?.metric).toBe('frameMs.p95');
  });

  it('warns when the sample size is too small to trust', () => {
    const runs = [[report('a', 16)], [report('a', 17)]];
    expect(analyzeVariance(runs).warnings.join()).toContain('信心有限');
  });

  it('skips a scene that is missing from some runs rather than crashing', () => {
    const runs = [[report('a', 16), report('b', 20)], [report('a', 16)], [report('a', 16)]];
    const result = analyzeVariance(runs);

    expect(result.rows.some((r) => r.scene === 'a')).toBe(true);
    expect(result.rows.some((r) => r.scene === 'b')).toBe(false);
  });
});

describe('formatVariance', () => {
  it('says the threshold can be tightened when variance is low', () => {
    const runs = [[report('a', 16)], [report('a', 16)], [report('a', 16)], [report('a', 16)]];
    const text = formatVariance(analyzeVariance(runs), 25);
    expect(text).toContain('收緊');
  });

  it('says the threshold is too low when variance exceeds it', () => {
    const runs = [[report('a', 16)], [report('a', 30)], [report('a', 16)], [report('a', 16)]];
    const text = formatVariance(analyzeVariance(runs), 5);
    expect(text).toContain('會產生誤報');
  });

  it('stays readable with no usable data', () => {
    const text = formatVariance(analyzeVariance([]), 15);
    expect(text).toContain('可用執行次數：0');
  });
});
