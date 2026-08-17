import type { Summary } from '@ww/core';
import { REPORT_SCHEMA_VERSION, type BenchmarkReport } from '@ww/diagnostics';
import { describe, expect, it } from 'vitest';
import { compareReports, displayWidth, formatComparison, padDisplay } from './compare.ts';

function summary(p95: number): Summary {
  return { count: 100, mean: p95, min: p95, max: p95, p50: p95, p95, p99: p95, stddev: 0 };
}

interface ReportOverrides {
  scene?: string;
  machineId?: string;
  frameP95?: number;
  cpuP95?: number;
  gpuP95?: number | null;
  peakMemoryBytes?: number;
  earlyTotalMs?: number;
  cpuReferenceMs?: number;
  memoryReferenceMs?: number;
}

function report(overrides: ReportOverrides = {}): BenchmarkReport {
  const frameP95 = overrides.frameP95 ?? 16;
  const gpuP95 = overrides.gpuP95 === undefined ? 8 : overrides.gpuP95;

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    engineVersion: '0.0.0-test',
    scene: overrides.scene ?? 'instancing',
    params: {},
    machineId: overrides.machineId ?? 'machine-a',
    cpuReferenceMs: overrides.cpuReferenceMs ?? 100,
    memoryReferenceMs: overrides.memoryReferenceMs ?? 50,
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
      cpuFrameMs: summary(overrides.cpuP95 ?? 4),
      gpuRenderMs: gpuP95 === null ? null : summary(gpuP95),
      gpuSampleCount: gpuP95 === null ? 0 : 150,
      fpsP50: 1000 / frameP95,
      fpsP1Low: 1000 / frameP95,
    },
    scopes: {},
    counters: { drawCalls: summary(10), triangles: summary(1000) },
    earlyFrames: {
      count: 30,
      totalMs: overrides.earlyTotalMs ?? 480,
      worstMs: 20,
      worstCpuMs: 5,
    },
    memory: {
      totalBytes: summary(1024),
      peakTotalBytes: overrides.peakMemoryBytes ?? 100 * 1024 * 1024,
      jsHeapPeakBytes: null,
      driftBytes: 0,
    },
    mainThread: { longTaskObservationSupported: true, longTasks: 0, longTaskMs: 0 },
  };
}

const options = { thresholdPct: 10 };

describe('displayWidth', () => {
  it('counts CJK characters as two columns', () => {
    expect(displayWidth('場景')).toBe(4);
    expect(displayWidth('scene')).toBe(5);
    expect(displayWidth('前30幀')).toBe(6); // 2 + 2 + 2
  });

  it('pads to an equal rendered width regardless of script', () => {
    expect(displayWidth(padDisplay('場景', 12))).toBe(12);
    expect(displayWidth(padDisplay('scene', 12))).toBe(12);
  });

  it('never truncates text that is already too wide', () => {
    expect(padDisplay('a-very-long-scene-name', 5)).toBe('a-very-long-scene-name');
  });
});

describe('formatComparison', () => {
  it('aligns the header with the data rows', () => {
    const text = formatComparison(compareReports([report()], [report()], options), 25);
    const [header, , firstRow] = text.split('\n');
    // 標題是中文、資料是英文；兩者的指標欄必須從同一個顯示欄位開始
    expect(displayWidth(header!.slice(0, header!.indexOf('指標')))).toBe(
      displayWidth(firstRow!.slice(0, firstRow!.indexOf('frameMs'))),
    );
  });

  it('states the outcome in the last line', () => {
    const pass = formatComparison(compareReports([report()], [report()], options), 25);
    expect(pass.trimEnd().split('\n').at(-1)).toContain('通過');

    const fail = formatComparison(
      compareReports([report({ frameP95: 10 })], [report({ frameP95: 30 })], options),
      25,
    );
    expect(fail.trimEnd().split('\n').at(-1)).toContain('失敗');
  });
});

describe('compareReports', () => {
  it('passes when nothing changed', () => {
    const result = compareReports([report()], [report()], options);
    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('flags a frame-time regression beyond the threshold', () => {
    const result = compareReports([report({ frameP95: 16 })], [report({ frameP95: 20 })], options);
    expect(result.passed).toBe(false);
    expect(result.regressions.map((r) => r.metric)).toContain('frameMs.p95');
    expect(result.regressions[0]!.deltaPct).toBeCloseTo(25, 6);
  });

  it('tolerates changes inside the threshold', () => {
    // +6% 在 10% 門檻內，屬於量測噪音範圍
    const result = compareReports([report({ frameP95: 16 })], [report({ frameP95: 17 })], options);
    expect(result.passed).toBe(true);
  });

  it('marks a large improvement without failing the run', () => {
    const result = compareReports([report({ frameP95: 20 })], [report({ frameP95: 10 })], options);
    expect(result.passed).toBe(true);
    expect(result.rows.some((r) => r.status === 'improved')).toBe(true);
  });

  it('catches a memory regression', () => {
    const result = compareReports(
      [report({ peakMemoryBytes: 100 * 1024 * 1024 })],
      [report({ peakMemoryBytes: 200 * 1024 * 1024 })],
      options,
    );
    expect(result.regressions.map((r) => r.metric)).toContain('peakMemoryMB');
  });

  it('refuses to compare across report schema versions', () => {
    // 舊基準少了新欄位，硬比會炸開或比出看似合理的錯誤結論
    const old = { ...report(), schemaVersion: 1 as unknown as BenchmarkReport['schemaVersion'] };
    const result = compareReports([old], [report()], options);
    expect(result.rows).toHaveLength(0);
    expect(result.warnings.join()).toContain('bench:baseline');
  });

  it('refuses to compare across machines', () => {
    // 跨機器數字沒有可比性；拿來卡只會產生假警報
    const result = compareReports(
      [report({ machineId: 'machine-a', frameP95: 8 })],
      [report({ machineId: 'machine-b', frameP95: 40 })],
      options,
    );
    expect(result.passed).toBe(true);
    expect(result.warnings.join()).toContain('另一台機器');
    expect(result.rows).toHaveLength(0);
  });

  it('warns about a scene with no baseline instead of silently skipping it', () => {
    const result = compareReports([report({ scene: 'instancing' })], [report({ scene: 'batching' })], options);
    expect(result.warnings.join()).toContain('batching');
    expect(result.warnings.join()).toContain('instancing');
  });

  it('warns when coverage shrinks', () => {
    // 基準有兩個場景，這次只跑一個 —— 靜默漏測比回歸更危險
    const result = compareReports(
      [report({ scene: 'instancing' }), report({ scene: 'batching' })],
      [report({ scene: 'instancing' })],
      options,
    );
    expect(result.warnings.some((w) => w.includes('覆蓋範圍縮小'))).toBe(true);
  });

  it('marks GPU metrics as missing rather than comparing against nothing', () => {
    const result = compareReports([report({ gpuP95: 8 })], [report({ gpuP95: null })], options);
    const gpuRow = result.rows.find((r) => r.metric === 'gpuRenderMs.p95');
    expect(gpuRow?.status).toBe('missing');
    expect(result.passed).toBe(true);
  });

  it('does not turn sub-millisecond noise into a regression', () => {
    // 實際遇過的假警報：0.425ms → 0.822ms 被算成「退步 93%」。
    // Chrome 把 performance.now() 量化到 0.1ms，這區間的百分比毫無意義。
    const result = compareReports([report({ gpuP95: 0.425 })], [report({ gpuP95: 0.822 })], options);
    const gpuRow = result.rows.find((r) => r.metric === 'gpuRenderMs.p95');
    expect(gpuRow?.status).toBe('ok');
    expect(result.passed).toBe(true);
  });

  it('still catches a regression once values clear the noise floor', () => {
    // 同樣是兩倍，但這次數字夠大，是真的
    const result = compareReports([report({ gpuP95: 8 })], [report({ gpuP95: 16 })], options);
    expect(result.regressions.map((r) => r.metric)).toContain('gpuRenderMs.p95');
  });

  it('catches a startup regression that the steady-state p95 hides', () => {
    // shader 編譯的成本只出現在開頭幾幀。整段 p95 完全一樣，
    // 但前 30 幀多花了 400ms —— 這正是 earlyFrames 存在的理由。
    const result = compareReports(
      [report({ frameP95: 16, earlyTotalMs: 480 })],
      [report({ frameP95: 16, earlyTotalMs: 900 })],
      options,
    );
    expect(result.rows.find((r) => r.metric === 'frameMs.p95')?.status).toBe('ok');
    expect(result.regressions.map((r) => r.metric)).toContain('earlyFramesTotalMs');
  });

  it('applies the noise floor per metric, not globally', () => {
    // 0.8ms 的 GPU 時間是噪音；0.8MB 的記憶體也在下限之下 —— 但兩者用的是
    // 各自的單位與門檻，不能共用一個全域數字
    const result = compareReports(
      [report({ gpuP95: 0.4, peakMemoryBytes: 300 * 1024 * 1024 })],
      [report({ gpuP95: 0.8, peakMemoryBytes: 600 * 1024 * 1024 })],
      options,
    );
    expect(result.rows.find((r) => r.metric === 'gpuRenderMs.p95')?.status).toBe('ok');
    expect(result.rows.find((r) => r.metric === 'peakMemoryMB')?.status).toBe('regressed');
  });
});

/**
 * 機器狀態的比對前提。
 *
 * 這一組是實測抓到的：同一份程式碼，baseline 與 bench 連續執行，四個
 * CPU 密集場景的 cpuFrameMs.p95 **全部乘上約 1.85 倍**，而 CPU 輕的場景
 * 與所有 GPU 指標完全不變。那是熱受限機器的降檔，不是雜訊 ——
 * 隨機爭用不會讓四個場景乘上同一個倍數。
 */
describe('compareReports with a different machine state', () => {
  it('refuses to compare when the CPU reference moved a lot', () => {
    // 列出一串假退步讓人逐一追查，比明確說「不可比較」糟糕得多
    const result = compareReports(
      [report({ cpuReferenceMs: 100,
    frameP95: 16 })],
      [report({ cpuReferenceMs: 185,
    frameP95: 30 })],
      options,
    );
    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
    expect(result.warnings.join()).toContain('機器狀態');
  });

  it('still compares when the CPU reference is close', () => {
    // 容許一般的量測抖動，否則這個檢查會讓比對永遠不發生
    const result = compareReports(
      [report({ cpuReferenceMs: 100,
    frameP95: 16 })],
      [report({ cpuReferenceMs: 105,
    frameP95: 40 })],
      options,
    );
    expect(result.regressions.length).toBeGreaterThan(0);
  });

  it('catches the slower direction too', () => {
    // 基準是在降檔狀態下產生的，之後在正常狀態比對 —— 一樣不可比較，
    // 而且這個方向更危險：它會讓真實的退步看起來像改善。
    const result = compareReports(
      [report({ cpuReferenceMs: 185,
    frameP95: 30 })],
      [report({ cpuReferenceMs: 100,
    frameP95: 16 })],
      options,
    );
    expect(result.warnings.join()).toContain('機器狀態');
  });
});

/**
 * 幀時間 p95 的量化豁免。
 *
 * 這一組的重點不是「豁免有沒有生效」，而是**它有沒有把真的退步一起放掉**。
 * 一個只會放行的豁免比沒有豁免更糟 —— 它讓閘門看起來還在。
 */
describe('refresh-interval quantisation', () => {
  /** 空場景決定校準值：它一定是被 present 節流的，p50 就是更新間隔。 */
  function withFloor(floorMs: number, scenes: readonly BenchmarkReport[]): BenchmarkReport[] {
    return [report({ scene: 'baseline-empty', frameP95: floorMs }), ...scenes];
  }

  function frameRow(result: ReturnType<typeof compareReports>, scene: string) {
    return result.rows.find((r) => r.scene === scene && r.metric === 'frameMs.p95');
  }

  it('ignores a jump smaller than one refresh interval', () => {
    // 實測形態：同一份程式碼，p95 在 6.30 與 9.91 之間跳，p50 都是 6.10。
    const base = withFloor(6.1, [report({ scene: 'world-streaming', frameP95: 6.3 })]);
    const current = withFloor(6.1, [report({ scene: 'world-streaming', frameP95: 9.91 })]);

    const result = compareReports(base, current, { thresholdPct: 40 });
    expect(frameRow(result, 'world-streaming')?.status).toBe('ok');
    expect(result.passed).toBe(true);
  });

  it('still catches a regression larger than one refresh interval', () => {
    // 6.3 → 20 是 +13.7ms，超過一個間隔，必須擋下來。
    // 沒有這一項的話，上面那個測試會誘使人把豁免放得越來越寬。
    const base = withFloor(6.1, [report({ scene: 'world-streaming', frameP95: 6.3 })]);
    const current = withFloor(6.1, [report({ scene: 'world-streaming', frameP95: 20 })]);

    const result = compareReports(base, current, { thresholdPct: 40 });
    expect(frameRow(result, 'world-streaming')?.status).toBe('regressed');
    expect(result.passed).toBe(false);
  });

  it('does not weaken the gate on heavy scenes', () => {
    // 99 → 145 是 +46%，遠超過一個間隔 —— 豁免完全不該碰到它。
    const base = withFloor(6.1, [report({ scene: 'material-complexity', frameP95: 99 })]);
    const current = withFloor(6.1, [report({ scene: 'material-complexity', frameP95: 145 })]);

    expect(compareReports(base, current, { thresholdPct: 40 }).passed).toBe(false);
  });

  it('falls back to no exemption when the calibration scene is missing', () => {
    // 拿不到校準值時寧可誤報，也不要靜靜地放寬門檻。
    const base = [report({ scene: 'world-streaming', frameP95: 6.3 })];
    const current = [report({ scene: 'world-streaming', frameP95: 9.91 })];

    const result = compareReports(base, current, { thresholdPct: 40 });
    expect(frameRow(result, 'world-streaming')?.status).toBe('regressed');
  });

  it('rejects an implausible calibration value', () => {
    // baseline-empty 自己壞掉時（例如量到 200ms）不能拿來當校準基準，
    // 否則它會把所有場景的所有變化都豁免掉。
    const base = withFloor(200, [report({ scene: 'world-streaming', frameP95: 6.3 })]);
    const current = withFloor(200, [report({ scene: 'world-streaming', frameP95: 9.91 })]);

    const result = compareReports(base, current, { thresholdPct: 40 });
    expect(frameRow(result, 'world-streaming')?.status).toBe('regressed');
  });
});

/**
 * 機器狀態閘門需要**兩個**參考值。
 *
 * `cpuReferenceMs` 是純整數、資料全在 L1 的迴圈 —— 只反映時脈與 IPC。
 * 那對「整台機器降檔」是對的，但它對記憶體頻寬劣化毫無反應。
 *
 * 實際漏掉過一次：`ecs-instancing` 的 CPU p95 從 15.40 跳到 30.41（+97%），
 * 而 CPU 參考值是 3.8 對 3.8 —— 一模一樣，於是比對認定可比較並報出假退步。
 * 後續四次獨立量測是 15.60 / 15.60 / 15.41 / 15.40，證實程式碼沒問題。
 */
describe('machine-state gate', () => {
  function drifted(overrides: Partial<{ cpu: number; mem: number }>) {
    const base = [report({ scene: 'ecs-instancing', cpuP95: 15.4 })];
    const current = [
      report({
        scene: 'ecs-instancing',
        cpuP95: 30.4,
        cpuReferenceMs: overrides.cpu ?? 100,
        memoryReferenceMs: overrides.mem ?? 50,
      }),
    ];
    return compareReports(base, current, { thresholdPct: 40 });
  }

  it('refuses to compare when the memory reference drifted', () => {
    // 這正是漏掉的那一次：CPU 參考值不動，記憶體頻寬掉了一半。
    const result = drifted({ cpu: 100, mem: 100 });
    expect(result.warnings.some((w) => w.includes('記憶體參考'))).toBe(true);
    expect(result.regressions).toEqual([]);
  });

  it('still refuses when only the CPU reference drifted', () => {
    const result = drifted({ cpu: 190, mem: 50 });
    expect(result.warnings.some((w) => w.includes('CPU 參考'))).toBe(true);
    expect(result.regressions).toEqual([]);
  });

  it('reports the regression when both references are stable', () => {
    // 閘門不能變成「永遠不報退步」。兩個參考值都穩定時，
    // 那個 +97% 就是真的要擋下來的東西。
    const result = drifted({ cpu: 100, mem: 50 });
    expect(result.warnings).toEqual([]);
    expect(result.regressions.length).toBeGreaterThan(0);
  });

  it('skips a reference that was never measured', () => {
    // 舊 schema 的報告沒有這個欄位（0）。不能拿 0 去算比值 ——
    // 那會讓每一次比對都被判定為「機器狀態不同」而永遠不比。
    const base = [report({ scene: 'ecs-instancing', cpuP95: 15.4, memoryReferenceMs: 0 })];
    const current = [report({ scene: 'ecs-instancing', cpuP95: 30.4, memoryReferenceMs: 0 })];
    const result = compareReports(base, current, { thresholdPct: 40 });
    expect(result.warnings).toEqual([]);
    expect(result.regressions.length).toBeGreaterThan(0);
  });
});
