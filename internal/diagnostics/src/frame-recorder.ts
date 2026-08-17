import { Float64RingBuffer, summarize, type Summary } from '@ww/core';
import type { RendererStatsSnapshot } from './telemetry.ts';

/**
 * 幀歷史紀錄。
 *
 * 用 structure-of-arrays（每個指標一條 Float64RingBuffer）而不是每幀一個物件：
 * 一個 600 幀的環形歷史若每幀配置一個物件，光是 profiler 本身每秒就會產生
 * 60 個短命物件。SoA 讓整個歷史在建構時一次配置完，執行期零配置。
 */
export interface FrameRecorderOptions {
  historyFrames?: number | undefined;
  scopeCount?: number | undefined;
}

const DEFAULT_HISTORY = 600;

/**
 * 開頭幾幀另外記一份，**不會被環形緩衝覆蓋**。
 *
 * 歷史是環形的，跑滿 600 幀之後開頭那幾幀就被蓋掉了 —— 但 shader 編譯、
 * 首次資源上傳這類啟動成本剛好只出現在那裡。整段 p95 會把幾幀的停頓稀釋掉，
 * 完全看不出來（實測：shader-compile 場景的 cold 與 precompiled 在 200 幀的
 * p95 上幾乎沒有差別，但實際編譯成本確實存在）。
 */
const EARLY_WINDOW = 30;

export interface EarlyFrameStats {
  count: number;
  /** 這段期間的總 wall-clock 時間。啟動成本主要反映在這裡。 */
  totalMs: number;
  /** 最慢的一幀（畫面間隔）。 */
  worstMs: number;
  /** 最長的一次主執行緒阻塞。 */
  worstCpuMs: number;
}

export interface FrameInput {
  frameId: number;
  /** 兩次 beginFrame 之間的間隔，也就是實際畫面更新間隔。 */
  deltaMs: number;
  /** beginFrame 到 endFrame 的主執行緒時間。 */
  cpuFrameMs: number;
  longTaskMs: number;
  jsHeapUsedBytes: number | null;
  stats: RendererStatsSnapshot;
}

export class FrameRecorder {
  readonly capacity: number;
  private readonly frameIds: Float64RingBuffer;
  private readonly deltaMs: Float64RingBuffer;
  private readonly cpuFrameMs: Float64RingBuffer;
  private readonly longTaskMs: Float64RingBuffer;
  private readonly heapBytes: Float64RingBuffer;
  private readonly drawCalls: Float64RingBuffer;
  private readonly triangles: Float64RingBuffer;
  private readonly memoryTotal: Float64RingBuffer;
  private readonly scopes: Float64RingBuffer[];

  /**
   * GPU 時間另外存一組。
   *
   * `resolveTimestampsAsync()` 是非同步的、會落後數幀，而且我們不會每幀都解析
   * （解析本身有成本）。硬把它塞回「當幀」的欄位會製造出對不上的資料。
   * 分開存、分開統計，並記錄它是哪一幀發出的請求。
   */
  private readonly gpuFrameIds: Float64RingBuffer;
  private readonly gpuRenderMs: Float64RingBuffer;
  private readonly gpuComputeMs: Float64RingBuffer;

  private readonly earlyDeltaMs = new Float64Array(EARLY_WINDOW);
  private readonly earlyCpuMs = new Float64Array(EARLY_WINDOW);
  private earlyCount = 0;

  private _peakMemoryBytes = 0;

  constructor(options: FrameRecorderOptions = {}) {
    this.capacity = options.historyFrames ?? DEFAULT_HISTORY;
    const scopeCount = options.scopeCount ?? 0;
    const make = (): Float64RingBuffer => new Float64RingBuffer(this.capacity);

    this.frameIds = make();
    this.deltaMs = make();
    this.cpuFrameMs = make();
    this.longTaskMs = make();
    this.heapBytes = make();
    this.drawCalls = make();
    this.triangles = make();
    this.memoryTotal = make();
    this.scopes = Array.from({ length: scopeCount }, make);
    this.gpuFrameIds = make();
    this.gpuRenderMs = make();
    this.gpuComputeMs = make();
  }

  get size(): number {
    return this.frameIds.size;
  }

  get gpuSampleCount(): number {
    return this.gpuRenderMs.size;
  }

  get peakMemoryBytes(): number {
    return this._peakMemoryBytes;
  }

  /**
   * 確保有足夠的 scope 序列。
   *
   * scope 可以在 Profiler 建立之後才註冊（例如某個系統延遲初始化）。若這裡不補
   * 配置，新 scope 的時間會被 record() 靜默丟棄 —— 量測工具無聲地少量一項，
   * 比直接壞掉更難發現。補配置的 buffer 從當下開始記錄，先前的幀維持沒有資料。
   */
  ensureScopes(count: number): void {
    while (this.scopes.length < count) {
      this.scopes.push(new Float64RingBuffer(this.capacity));
    }
  }

  get scopeCount(): number {
    return this.scopes.length;
  }

  record(input: FrameInput, scopeDurations: ArrayLike<number>): void {
    this.frameIds.push(input.frameId);
    this.deltaMs.push(input.deltaMs);
    this.cpuFrameMs.push(input.cpuFrameMs);
    this.longTaskMs.push(input.longTaskMs);
    this.heapBytes.push(input.jsHeapUsedBytes ?? Number.NaN);
    this.drawCalls.push(input.stats.drawCalls);
    this.triangles.push(input.stats.triangles);
    this.memoryTotal.push(input.stats.memoryTotalBytes);

    if (input.stats.memoryTotalBytes > this._peakMemoryBytes) {
      this._peakMemoryBytes = input.stats.memoryTotalBytes;
    }

    if (this.earlyCount < EARLY_WINDOW) {
      this.earlyDeltaMs[this.earlyCount] = input.deltaMs;
      this.earlyCpuMs[this.earlyCount] = input.cpuFrameMs;
      this.earlyCount++;
    }

    for (let i = 0; i < this.scopes.length; i++) {
      this.scopes[i]!.push(scopeDurations[i] ?? 0);
    }
  }

  /** 開頭數幀的統計。只有在 warmup 為 0 時才代表真正的啟動成本。 */
  earlyFrames(): EarlyFrameStats {
    const n = this.earlyCount;
    let total = 0;
    let worst = 0;
    let worstCpu = 0;
    for (let i = 0; i < n; i++) {
      const delta = this.earlyDeltaMs[i]!;
      total += delta;
      if (delta > worst) worst = delta;
      const cpu = this.earlyCpuMs[i]!;
      if (cpu > worstCpu) worstCpu = cpu;
    }
    return { count: n, totalMs: total, worstMs: worst, worstCpuMs: worstCpu };
  }

  /**
   * GPU 記憶體漂移：後 1/4 的平均減去前 1/4 的平均。
   *
   * 穩定的場景應該接近 0。持續為正代表有東西每幀在配置卻沒有釋放 ——
   * 這是 device-loss 恢復流程漏 dispose 最直接的訊號，對所有場景也都是
   * 便宜的洩漏偵測。樣本太少時回傳 0 而不是雜訊。
   */
  memoryDriftBytes(): number {
    const n = this.memoryTotal.size;
    if (n < 16) return 0;
    const quarter = Math.floor(n / 4);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < quarter; i++) {
      head += this.memoryTotal.at(i);
      tail += this.memoryTotal.at(n - 1 - i);
    }
    return (tail - head) / quarter;
  }

  recordGpu(frameId: number, renderMs: number | null, computeMs: number | null): void {
    if (renderMs === null) return;
    this.gpuFrameIds.push(frameId);
    this.gpuRenderMs.push(renderMs);
    this.gpuComputeMs.push(computeMs ?? 0);
  }

  clear(): void {
    for (const buffer of [
      this.frameIds,
      this.deltaMs,
      this.cpuFrameMs,
      this.longTaskMs,
      this.heapBytes,
      this.drawCalls,
      this.triangles,
      this.memoryTotal,
      this.gpuFrameIds,
      this.gpuRenderMs,
      this.gpuComputeMs,
      ...this.scopes,
    ]) {
      buffer.clear();
    }
    this._peakMemoryBytes = 0;
    // 暖機結束後呼叫 clear()，開頭視窗要跟著重新起算：
    // 對有暖機的場景，「開頭」指的是量測開始之後，不是程式啟動之後。
    this.earlyCount = 0;
  }

  // ── 讀取 ────────────────────────────────────────────────────────────────

  summaryOf(series: SeriesName): Summary {
    const buffer = this.seriesBuffer(series);
    return summarize(buffer.toArray(), buffer.size);
  }

  scopeSummary(index: number): Summary {
    const buffer = this.scopes[index];
    if (buffer === undefined) return summarize([], 0);
    return summarize(buffer.toArray(), buffer.size);
  }

  /** GPU 時間的統計。沒有任何樣本時回傳 null 而不是全 0。 */
  gpuRenderSummary(): Summary | null {
    if (this.gpuRenderMs.size === 0) return null;
    return summarize(this.gpuRenderMs.toArray(), this.gpuRenderMs.size);
  }

  series(name: SeriesName): Float64Array {
    return this.seriesBuffer(name).toArray();
  }

  private seriesBuffer(name: SeriesName): Float64RingBuffer {
    switch (name) {
      case 'frameId':
        return this.frameIds;
      case 'deltaMs':
        return this.deltaMs;
      case 'cpuFrameMs':
        return this.cpuFrameMs;
      case 'longTaskMs':
        return this.longTaskMs;
      case 'heapBytes':
        return this.heapBytes;
      case 'drawCalls':
        return this.drawCalls;
      case 'triangles':
        return this.triangles;
      case 'memoryTotalBytes':
        return this.memoryTotal;
      case 'gpuRenderMs':
        return this.gpuRenderMs;
      case 'gpuComputeMs':
        return this.gpuComputeMs;
    }
  }
}

export type SeriesName =
  | 'frameId'
  | 'deltaMs'
  | 'cpuFrameMs'
  | 'longTaskMs'
  | 'heapBytes'
  | 'drawCalls'
  | 'triangles'
  | 'memoryTotalBytes'
  | 'gpuRenderMs'
  | 'gpuComputeMs';
