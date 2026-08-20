import { QualityTier, UNKNOWN_ADAPTER } from '@ww/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Profiler } from './profiler.ts';
import { REPORT_SCHEMA_VERSION, buildReport, reportsToCsv, type ReportMeta } from './report.ts';
import { EMPTY_STATS, type GpuTimingSample, type RendererTelemetry } from './telemetry.ts';

let clock = 0;
const advance = (ms: number): void => {
  clock += ms;
};

beforeEach(() => {
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

class FakeTelemetry implements RendererTelemetry {
  resolveCount = 0;
  drawCalls = 10;
  memoryTotalBytes = 1024;

  constructor(
    readonly timestampsAvailable: boolean,
    private readonly timing: GpuTimingSample = { renderMs: 5, computeMs: 1 },
  ) {}

  readStats() {
    return { ...EMPTY_STATS, drawCalls: this.drawCalls, memoryTotalBytes: this.memoryTotalBytes };
  }

  resolveGpuTimings(): Promise<GpuTimingSample> {
    this.resolveCount++;
    return Promise.resolve(this.timing);
  }
}

function runFrames(profiler: Profiler, count: number, frameMs = 16): void {
  for (let i = 0; i < count; i++) {
    profiler.beginFrame();
    advance(frameMs);
    profiler.endFrame();
  }
}

const meta = (): ReportMeta => ({
  engineVersion: '0.0.0-test',
  scene: 'unit-test',
  params: { count: 100 },
  machineId: 'test-machine',
  cpuReferenceMs: 100,
  memoryReferenceMs: 50,
  platform: {
    backend: 'webgpu',
    tier: QualityTier.DesktopHigh,
    tierReasons: [],
    adapter: UNKNOWN_ADAPTER,
    timestampsAvailable: false,
    userAgent: 'test',
    devicePixelRatio: 1,
    viewportWidth: 1920,
    viewportHeight: 1080,
  },
});

describe('Profiler', () => {
  it('registers the default scopes', () => {
    const p = new Profiler();
    expect(p.scopeIds.has('Simulation')).toBe(true);
    expect(p.scopeIds.has('Present')).toBe(true);
    p.dispose();
  });

  it('records one history entry per frame', () => {
    const p = new Profiler({ historyFrames: 100 });
    runFrames(p, 10);
    expect(p.frameCount).toBe(10);
    expect(p.recorder.size).toBe(10);
    p.dispose();
  });

  it('measures the inter-frame delta, not just the work time', () => {
    const p = new Profiler();
    p.beginFrame();
    advance(5);
    p.endFrame();
    advance(11); // 空閒時間也算進畫面間隔
    p.beginFrame();
    advance(5);
    p.endFrame();

    const deltas = p.recorder.summaryOf('deltaMs');
    expect(deltas.max).toBeCloseTo(16, 6);
    p.dispose();
  });

  it('caps history at the ring buffer capacity', () => {
    const p = new Profiler({ historyFrames: 32 });
    runFrames(p, 200);
    expect(p.recorder.size).toBe(32);
    expect(p.frameCount).toBe(200);
    p.dispose();
  });

  it('tracks peak GPU memory across the run', () => {
    const telemetry = new FakeTelemetry(false);
    const p = new Profiler({ telemetry });
    runFrames(p, 3);
    telemetry.memoryTotalBytes = 999_999;
    runFrames(p, 1);
    telemetry.memoryTotalBytes = 512;
    runFrames(p, 3);

    expect(p.recorder.peakMemoryBytes).toBe(999_999);
    p.dispose();
  });

  it('reports GPU timing as null, never as zero, when unavailable', () => {
    // 這是最重要的一條：0 會被誤讀成「非常快」，null 才是「量不到」
    const p = new Profiler({ telemetry: new FakeTelemetry(false) });
    runFrames(p, 20);

    expect(p.timestampsAvailable).toBe(false);
    expect(p.recorder.gpuRenderSummary()).toBeNull();
    expect(buildReport(p, meta()).timing.gpuRenderMs).toBeNull();
    p.dispose();
  });

  it('never asks the backend to resolve timestamps when they are unsupported', () => {
    const telemetry = new FakeTelemetry(false);
    const p = new Profiler({ telemetry });
    runFrames(p, 40);
    expect(telemetry.resolveCount).toBe(0);
    p.dispose();
  });

  it('collects GPU samples when timestamps are supported', async () => {
    const telemetry = new FakeTelemetry(true, { renderMs: 7.5, computeMs: 0.5 });
    const p = new Profiler({ telemetry, gpuResolveIntervalFrames: 2 });

    for (let i = 0; i < 10; i++) {
      p.beginFrame();
      advance(16);
      p.endFrame();
      await Promise.resolve();
      await Promise.resolve();
    }

    const gpu = p.recorder.gpuRenderSummary();
    expect(gpu).not.toBeNull();
    expect(gpu!.p50).toBeCloseTo(7.5, 6);
    expect(p.recorder.gpuSampleCount).toBeGreaterThan(0);
    p.dispose();
  });

  it('does not stack up overlapping resolve requests', async () => {
    // 解析未回來就再發一次，只會讓延遲越積越長
    let release!: (value: GpuTimingSample) => void;
    const pending = new Promise<GpuTimingSample>((resolve) => {
      release = resolve;
    });

    const telemetry: RendererTelemetry = {
      timestampsAvailable: true,
      readStats: () => EMPTY_STATS,
      resolveGpuTimings: vi.fn(() => pending),
    };

    const p = new Profiler({ telemetry, gpuResolveIntervalFrames: 1 });
    runFrames(p, 10);

    expect(telemetry.resolveGpuTimings).toHaveBeenCalledTimes(1);
    release({ renderMs: 1, computeMs: 0 });
    p.dispose();
  });

  it('records a scope registered after construction', () => {
    // 曾經的靜默 bug：晚註冊的 scope 沒有序列，時間量到了卻不會進報告
    const p = new Profiler({ historyFrames: 50 });
    const late = p.scope('LateSystem');

    p.beginFrame();
    p.cpu.begin(late);
    advance(3);
    p.cpu.end(late);
    advance(13);
    p.endFrame();

    expect(p.scopeIds.has('LateSystem')).toBe(true);
    expect(p.recorder.scopeSummary(late).p50).toBeCloseTo(3, 6);
    expect(buildReport(p, meta()).scopes['LateSystem']?.p50).toBeCloseTo(3, 6);
    p.dispose();
  });

  it('returns the same id when the same scope is requested twice', () => {
    const p = new Profiler();
    expect(p.scope('Simulation')).toBe(p.scopeIds.get('Simulation'));
    expect(p.scope('Custom')).toBe(p.scope('Custom'));
    p.dispose();
  });

  it('discards warm-up data on reset', () => {
    const p = new Profiler();
    runFrames(p, 30, 50); // 慢的暖機幀
    p.reset();
    runFrames(p, 10, 16);

    expect(p.recorder.size).toBe(10);
    expect(p.recorder.summaryOf('deltaMs').max).toBeLessThan(20);
    p.dispose();
  });
});

describe('buildReport', () => {
  it('produces a comparable report', () => {
    const p = new Profiler({ telemetry: new FakeTelemetry(false) });
    runFrames(p, 50, 16);

    const report = buildReport(p, meta());
    expect(report.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(report.frames).toBe(50);
    expect(report.scene).toBe('unit-test');
    expect(report.timing.fpsP50).toBeCloseTo(62.5, 1);
    expect(report.scopes['Simulation']).toBeDefined();
    expect(report.counters.drawCalls.p50).toBe(10);
    expect(report.notes).toEqual([]);
    p.dispose();
  });

  it('reports the 1% low separately from the median', () => {
    // 90 幀順暢 + 10 幀嚴重 stutter：中位數看起來完全正常，1% low 才會揭露問題
    const p = new Profiler();
    runFrames(p, 90, 16);
    runFrames(p, 10, 200);

    const report = buildReport(p, meta());
    expect(report.frames).toBe(100);
    expect(report.timing.fpsP50).toBeGreaterThan(50);
    expect(report.timing.fpsP1Low).toBeLessThan(20);
    p.dispose();
  });
});

describe('reportsToCsv', () => {
  it('emits a header plus one row per report', () => {
    const p = new Profiler();
    runFrames(p, 5);
    const csv = reportsToCsv([buildReport(p, meta())]);
    const lines = csv.split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('scene');
    expect(lines[1]).toContain('unit-test');
    p.dispose();
  });

  it('leaves the GPU columns empty rather than writing 0 when unmeasured', () => {
    const p = new Profiler();
    runFrames(p, 5);
    const csv = reportsToCsv([buildReport(p, meta())]);
    expect(csv.split('\n')[1]).toContain(',,');
    p.dispose();
  });
});
