/**
 * 把 JavaScript GC 列為必須觀察的 CPU 項目，但瀏覽器沒有標準的 GC 事件。
 * 能拿到的替代訊號是：
 *   1. long task —— 超過 50ms 的主執行緒阻塞，GC 停頓會出現在這裡
 *   2. JS heap 大小趨勢 —— 只有 Chromium 提供，且是非標準 API
 *
 * 兩者都拿不到時如實回報 null，不要猜。
 */

export interface MainThreadSample {
  longTasksThisFrame: number;
  longTaskMsThisFrame: number;
  /** 非 Chromium 瀏覽器為 null。 */
  jsHeapUsedBytes: number | null;
}

interface ChromiumMemory {
  usedJSHeapSize: number;
}

export class MainThreadWatcher {
  private observer: PerformanceObserver | null = null;
  private pendingCount = 0;
  private pendingMs = 0;
  private _totalLongTasks = 0;
  private _totalLongTaskMs = 0;
  private _peakHeapBytes = 0;
  private _supported = false;

  get longTaskObservationSupported(): boolean {
    return this._supported;
  }

  get totalLongTasks(): number {
    return this._totalLongTasks;
  }

  get totalLongTaskMs(): number {
    return this._totalLongTaskMs;
  }

  get peakHeapBytes(): number | null {
    return this._peakHeapBytes > 0 ? this._peakHeapBytes : null;
  }

  start(): void {
    if (this.observer !== null) return;
    if (typeof PerformanceObserver === 'undefined') return;

    const supported = PerformanceObserver.supportedEntryTypes;
    if (Array.isArray(supported) && !supported.includes('longtask')) return;

    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.pendingCount++;
          this.pendingMs += entry.duration;
          this._totalLongTasks++;
          this._totalLongTaskMs += entry.duration;
        }
      });
      this.observer.observe({ entryTypes: ['longtask'] });
      this._supported = true;
    } catch {
      this.observer = null;
      this._supported = false;
    }
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  /** 取出並清空本幀累計。每幀呼叫一次。 */
  consumeFrame(): MainThreadSample {
    const heap = readHeapBytes();
    if (heap !== null && heap > this._peakHeapBytes) this._peakHeapBytes = heap;

    const sample: MainThreadSample = {
      longTasksThisFrame: this.pendingCount,
      longTaskMsThisFrame: this.pendingMs,
      jsHeapUsedBytes: heap,
    };
    this.pendingCount = 0;
    this.pendingMs = 0;
    return sample;
  }

  reset(): void {
    this.pendingCount = 0;
    this.pendingMs = 0;
    this._totalLongTasks = 0;
    this._totalLongTaskMs = 0;
    this._peakHeapBytes = 0;
  }
}

function readHeapBytes(): number | null {
  if (typeof performance === 'undefined') return null;
  const memory = (performance as unknown as { memory?: ChromiumMemory }).memory;
  if (memory === undefined || typeof memory.usedJSHeapSize !== 'number') return null;
  return memory.usedJSHeapSize;
}
