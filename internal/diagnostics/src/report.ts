import type { AdapterIdentity, QualityTier, RenderBackendKind, Summary } from '@ww/core';
import type { EarlyFrameStats } from './frame-recorder.ts';
import type { Profiler } from './profiler.ts';

/**
 * 報告結構版本。**新增或改變欄位時必須遞增。**
 *
 * 舊基準缺少新欄位，直接拿來比對會在存取時炸開，或更糟 —— 比對出看似合理的
 * 錯誤結論。版本不符時應該明確要求重新產生基準，而不是想辦法相容。
 *
 * 2：新增 earlyFrames、memory.driftBytes、verdict
 */
export const REPORT_SCHEMA_VERSION = 4;

export interface ReportPlatform {
  backend: RenderBackendKind;
  tier: QualityTier;
  tierReasons: string[];
  adapter: AdapterIdentity;
  timestampsAvailable: boolean;
  userAgent: string;
  devicePixelRatio: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface ReportMeta {
  engineVersion: string;
  scene: string;
  params: Record<string, string | number | boolean>;
  /** 同一台機器上必須穩定；跨機器數字不可比較，baseline 依它分檔。 */
  machineId: string;
  /**
   * 這次執行時機器的 CPU 吞吐指標（毫秒，越小越快）。
   *
   * 跑一段固定的純 CPU 工作並計時。它**不是效能指標**，是「這兩次執行
   * 的機器狀態是否可比較」的判準。
   *
   * 存在的理由是實測到的一次失效：同一份程式碼，baseline 與 bench 連續
   * 執行，四個 CPU 密集場景的 cpuFrameMs.p95 全部乘上約 1.85 倍，而
   * CPU 輕的場景與所有 GPU 指標完全不變。隨機爭用不會讓四個場景乘上
   * 同一個倍數 —— 那是整台機器的 CPU 時脈在該次執行中降檔了。
   *
   * 門檻調不動這種情況：它不是雜訊，是**兩次量測的前提不同**。
   * 有了這個數字，比對工具可以直接說「不可比較」而不是列出一串假退步。
   */
  cpuReferenceMs: number;
  /**
   * 記憶體頻寬的參考量測。與 cpuReferenceMs 互補 ——
   * 後者只反映時脈與 IPC，對頻寬劣化完全沒有反應。
   */
  memoryReferenceMs: number;
  platform: ReportPlatform;
  /**
   * 執行時的環境限制。例如「以 SwiftShader 執行」「跳過 fill 子測試」。
   * 的精神：任何被截短的覆蓋範圍都要說出來，不能靜默。
   */
  notes?: string[] | undefined;
  /**
   * 場景的自我檢查結果。
   *
   * 有些場景驗證的是正確性而非效能（device loss 是否真的恢復）。把判斷寫進
   * 報告，runner 才能自動判定成敗，而不是要人每次用眼睛看數字。
   */
  verdict?: { ok: boolean; detail: string } | null | undefined;
}

export interface BenchmarkReport extends ReportMeta {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  capturedAt: string;
  frames: number;
  timing: {
    /** 實際畫面間隔。 */
    deltaMs: Summary;
    /** 主執行緒工作時間。 */
    cpuFrameMs: Summary;
    /**
     * 整幀 GPU 時間。不支援 timestamp query 時為 null。
     * 注意這是 whole-frame，不是 per-pass —— per-pass 要等 Render Graph。
     */
    gpuRenderMs: Summary | null;
    gpuSampleCount: number;
    fpsP50: number;
    /** 最差 1% 的 FPS。stutter 出現在這裡，不在平均值裡。 */
    fpsP1Low: number;
  };
  scopes: Record<string, Summary>;
  counters: {
    drawCalls: Summary;
    triangles: Summary;
  };
  /**
   * 量測開頭數幀的成本。
   *
   * 整段的 p95 會把只出現在開頭幾幀的停頓稀釋掉，所以 shader 編譯與首次資源
   * 上傳這類啟動成本必須單獨看。warmup 為 0 的場景，這裡才代表真正的啟動成本。
   */
  earlyFrames: EarlyFrameStats;
  memory: {
    totalBytes: Summary;
    peakTotalBytes: number;
    jsHeapPeakBytes: number | null;
    /** 後 1/4 與前 1/4 的平均差。持續為正代表有資源沒被釋放。 */
    driftBytes: number;
  };
  mainThread: {
    longTaskObservationSupported: boolean;
    longTasks: number;
    longTaskMs: number;
  };
}

export function buildReport(profiler: Profiler, meta: ReportMeta): BenchmarkReport {
  const { recorder } = profiler;

  const deltaMs = recorder.summaryOf('deltaMs');
  const scopes: Record<string, Summary> = {};
  for (const [name, id] of profiler.scopeIds) {
    scopes[name] = recorder.scopeSummary(id);
  }

  return {
    ...meta,
    notes: meta.notes ?? [],
    verdict: meta.verdict ?? null,
    schemaVersion: REPORT_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    frames: recorder.size,
    timing: {
      deltaMs,
      cpuFrameMs: recorder.summaryOf('cpuFrameMs'),
      gpuRenderMs: recorder.gpuRenderSummary(),
      gpuSampleCount: recorder.gpuSampleCount,
      fpsP50: msToFps(deltaMs.p50),
      // 幀時間的 p99 就是 FPS 的 1% low
      fpsP1Low: msToFps(deltaMs.p99),
    },
    scopes,
    counters: {
      drawCalls: recorder.summaryOf('drawCalls'),
      triangles: recorder.summaryOf('triangles'),
    },
    earlyFrames: recorder.earlyFrames(),
    memory: {
      totalBytes: recorder.summaryOf('memoryTotalBytes'),
      peakTotalBytes: recorder.peakMemoryBytes,
      jsHeapPeakBytes: profiler.mainThread.peakHeapBytes,
      driftBytes: recorder.memoryDriftBytes(),
    },
    mainThread: {
      longTaskObservationSupported: profiler.mainThread.longTaskObservationSupported,
      longTasks: profiler.mainThread.totalLongTasks,
      longTaskMs: profiler.mainThread.totalLongTaskMs,
    },
  };
}

function msToFps(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? 1000 / ms : 0;
}

const CSV_COLUMNS = [
  'scene',
  'machineId',
  'backend',
  'tier',
  'frames',
  'deltaMsP50',
  'deltaMsP95',
  'deltaMsP99',
  'cpuFrameMsP50',
  'cpuFrameMsP95',
  'gpuRenderMsP50',
  'gpuRenderMsP95',
  'fpsP50',
  'fpsP1Low',
  'earlyTotalMs',
  'earlyWorstMs',
  'drawCallsP50',
  'trianglesP50',
  'peakMemoryMB',
  'memoryDriftMB',
  'longTasks',
  'capturedAt',
] as const;

/** 回歸追蹤用的扁平格式，方便丟進試算表或畫趨勢圖。 */
export function reportsToCsv(reports: readonly BenchmarkReport[]): string {
  const rows = [CSV_COLUMNS.join(',')];
  for (const r of reports) {
    rows.push(
      [
        csvEscape(r.scene),
        csvEscape(r.machineId),
        r.platform.backend,
        r.platform.tier,
        r.frames,
        fixed(r.timing.deltaMs.p50),
        fixed(r.timing.deltaMs.p95),
        fixed(r.timing.deltaMs.p99),
        fixed(r.timing.cpuFrameMs.p50),
        fixed(r.timing.cpuFrameMs.p95),
        r.timing.gpuRenderMs === null ? '' : fixed(r.timing.gpuRenderMs.p50),
        r.timing.gpuRenderMs === null ? '' : fixed(r.timing.gpuRenderMs.p95),
        fixed(r.timing.fpsP50, 1),
        fixed(r.timing.fpsP1Low, 1),
        fixed(r.earlyFrames.totalMs, 1),
        fixed(r.earlyFrames.worstMs, 2),
        fixed(r.counters.drawCalls.p50, 0),
        fixed(r.counters.triangles.p50, 0),
        fixed(r.memory.peakTotalBytes / (1024 * 1024), 1),
        fixed(r.memory.driftBytes / (1024 * 1024), 2),
        r.mainThread.longTasks,
        r.capturedAt,
      ].join(','),
    );
  }
  return rows.join('\n');
}

function fixed(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '';
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
