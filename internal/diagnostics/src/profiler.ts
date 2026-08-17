import { CpuProfiler, DEFAULT_SCOPES, type ScopeId } from './cpu-profiler.ts';
import { FrameRecorder } from './frame-recorder.ts';
import { MainThreadWatcher } from './main-thread-watcher.ts';
import {
  EMPTY_STATS,
  NO_GPU_TIMING,
  type GpuTimingSample,
  type RendererStatsSnapshot,
  type RendererTelemetry,
} from './telemetry.ts';

export interface ProfilerOptions {
  historyFrames?: number | undefined;
  telemetry?: RendererTelemetry | null | undefined;
  /**
   * 每 N 幀解析一次 GPU timestamp。
   * 解析本身有成本且結果會落後，沒有必要每幀都做。
   */
  gpuResolveIntervalFrames?: number | undefined;
  scopes?: readonly string[] | undefined;
}

export interface FrameView {
  frameId: number;
  deltaMs: number;
  fps: number;
  cpuFrameMs: number;
  gpu: GpuTimingSample;
  stats: RendererStatsSnapshot;
  longTaskMs: number;
  jsHeapUsedBytes: number | null;
}

/**
 * 把 CPU scope 計時、GPU timestamp、renderer 統計與主執行緒觀察串成一個門面。
 *
 * 使用方式：
 *
 *   profiler.beginFrame();
 *   profiler.cpu.begin(simulationScope);
 *   ...
 *   profiler.cpu.end(simulationScope);
 *   renderer.render(scene, camera);
 *   profiler.endFrame();
 */
export class Profiler {
  readonly cpu = new CpuProfiler();
  readonly recorder: FrameRecorder;
  readonly mainThread = new MainThreadWatcher();
  private readonly _scopeIds = new Map<string, ScopeId>();

  private telemetry: RendererTelemetry | null;
  private readonly gpuResolveInterval: number;
  private frameId = 0;
  /**
   * NaN 代表「還沒有前一幀」。
   * 不能用 0 當哨兵 —— performance.now() 在啟動瞬間本來就可能非常接近 0，
   * 那會讓第二幀的 delta 也被誤判成第一幀而回報 0。
   */
  private lastBeginMs = Number.NaN;
  private currentDeltaMs = 0;
  private gpuResolveInFlight = false;
  private _lastStats: RendererStatsSnapshot = EMPTY_STATS;
  private _lastGpu: GpuTimingSample = NO_GPU_TIMING;
  private _lastLongTaskMs = 0;
  private _lastHeapBytes: number | null = null;

  constructor(options: ProfilerOptions = {}) {
    const scopeNames = options.scopes ?? DEFAULT_SCOPES;
    for (const name of scopeNames) this._scopeIds.set(name, this.cpu.registerScope(name));

    this.recorder = new FrameRecorder({
      historyFrames: options.historyFrames,
      scopeCount: this.cpu.scopeCount,
    });
    this.telemetry = options.telemetry ?? null;
    this.gpuResolveInterval = Math.max(1, options.gpuResolveIntervalFrames ?? 4);
    this.mainThread.start();
  }

  /** device 遺失後 renderer 會被重建，此時要換上新的 telemetry 來源。 */
  setTelemetry(telemetry: RendererTelemetry | null): void {
    this.telemetry = telemetry;
    this._lastGpu = NO_GPU_TIMING;
  }

  get timestampsAvailable(): boolean {
    return this.telemetry?.timestampsAvailable ?? false;
  }

  get scopeIds(): ReadonlyMap<string, ScopeId> {
    return this._scopeIds;
  }

  /**
   * 取得（必要時建立）一個 scope。
   *
   * 延遲註冊是允許的，但新 scope 必須同時進到 `_scopeIds`，否則
   * `buildReport()` 走訪這張表時會漏掉它 —— 時間有量到卻不會出現在報告裡。
   */
  scope(name: string): ScopeId {
    const existing = this._scopeIds.get(name);
    if (existing !== undefined) return existing;
    const id = this.cpu.registerScope(name);
    this._scopeIds.set(name, id);
    this.recorder.ensureScopes(this.cpu.scopeCount);
    return id;
  }

  beginFrame(now = performance.now()): void {
    this.currentDeltaMs = Number.isNaN(this.lastBeginMs) ? 0 : now - this.lastBeginMs;
    this.lastBeginMs = now;
    this.cpu.beginFrame(now);
  }

  endFrame(now = performance.now()): void {
    this.cpu.endFrame(now);

    const stats = this.telemetry?.readStats() ?? EMPTY_STATS;
    this._lastStats = stats;

    const mainThread = this.mainThread.consumeFrame();
    this._lastLongTaskMs = mainThread.longTaskMsThisFrame;
    this._lastHeapBytes = mainThread.jsHeapUsedBytes;

    // scope 可能在建構之後才被註冊；沒有對應的序列就會被靜默丟棄
    this.recorder.ensureScopes(this.cpu.scopeCount);

    this.recorder.record(
      {
        frameId: this.frameId,
        deltaMs: this.currentDeltaMs,
        cpuFrameMs: this.cpu.frameMs,
        longTaskMs: mainThread.longTaskMsThisFrame,
        jsHeapUsedBytes: mainThread.jsHeapUsedBytes,
        stats,
      },
      this.cpu.durations,
    );

    this.maybeResolveGpu(this.frameId);
    this.frameId++;
  }

  private maybeResolveGpu(frameId: number): void {
    const telemetry = this.telemetry;
    if (telemetry === null || !telemetry.timestampsAvailable) return;
    // 上一次解析還沒回來就跳過。堆積未完成的解析只會讓延遲越來越長。
    if (this.gpuResolveInFlight) return;
    if (frameId % this.gpuResolveInterval !== 0) return;

    this.gpuResolveInFlight = true;
    telemetry
      .resolveGpuTimings()
      .then((sample) => {
        this._lastGpu = sample;
        this.recorder.recordGpu(frameId, sample.renderMs, sample.computeMs);
      })
      .catch(() => {
        // 解析失敗不影響本幀；下一次間隔會再試
      })
      .finally(() => {
        this.gpuResolveInFlight = false;
      });
  }

  get lastFrame(): FrameView {
    return {
      frameId: this.frameId - 1,
      deltaMs: this.currentDeltaMs,
      fps: this.currentDeltaMs > 0 ? 1000 / this.currentDeltaMs : 0,
      cpuFrameMs: this.cpu.frameMs,
      gpu: this._lastGpu,
      stats: this._lastStats,
      longTaskMs: this._lastLongTaskMs,
      jsHeapUsedBytes: this._lastHeapBytes,
    };
  }

  get frameCount(): number {
    return this.frameId;
  }

  /** 丟棄暖機階段的資料。量測正式開始前呼叫。 */
  reset(): void {
    this.recorder.clear();
    this.mainThread.reset();
    this.frameId = 0;
    this.lastBeginMs = Number.NaN;
    this.currentDeltaMs = 0;
  }

  dispose(): void {
    this.mainThread.stop();
    this.telemetry = null;
  }
}
