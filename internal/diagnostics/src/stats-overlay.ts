import type { Profiler } from './profiler.ts';

/**
 * 用 DOM 而不是 3D 物件來畫 overlay。
 *
 * 如果 overlay 本身是場景的一部分，它就會出現在 draw call 統計、被後處理影響、
 * 也會佔用 GPU 時間 —— 量測工具不該污染被量測的對象。
 */

export interface StatsOverlayOptions {
  container?: HTMLElement | undefined;
  /** 更新頻率。每幀重寫 DOM 會自己變成效能問題。 */
  updateIntervalMs?: number | undefined;
}

const STYLE = `
position:fixed;top:8px;left:8px;z-index:99999;
font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
color:#e6edf3;background:rgba(13,17,23,.82);
border:1px solid rgba(110,118,129,.4);border-radius:6px;
padding:8px 10px;min-width:264px;white-space:pre;
pointer-events:none;backdrop-filter:blur(4px);
`;

export class StatsOverlay {
  private readonly root: HTMLElement | null;
  private readonly headerEl: HTMLElement | null = null;
  private readonly bodyEl: HTMLElement | null = null;
  private readonly statusEl: HTMLElement | null = null;
  private readonly updateIntervalMs: number;
  private lastUpdate = 0;

  constructor(options: StatsOverlayOptions = {}) {
    this.updateIntervalMs = options.updateIntervalMs ?? 250;

    if (typeof document === 'undefined') {
      this.root = null;
      return;
    }

    const root = document.createElement('div');
    root.setAttribute('data-ww-overlay', '');
    root.setAttribute('style', STYLE);

    this.headerEl = document.createElement('div');
    this.headerEl.style.color = '#7ee787';
    this.headerEl.style.marginBottom = '6px';

    this.bodyEl = document.createElement('div');

    this.statusEl = document.createElement('div');
    this.statusEl.style.marginTop = '6px';
    this.statusEl.style.display = 'none';

    root.append(this.headerEl, this.bodyEl, this.statusEl);
    (options.container ?? document.body).append(root);
    this.root = root;
  }

  setHeader(lines: readonly string[]): void {
    if (this.headerEl === null) return;
    this.headerEl.textContent = lines.join('\n');
  }

  setStatus(text: string | null, kind: 'info' | 'warn' | 'error' = 'info'): void {
    if (this.statusEl === null) return;
    if (text === null) {
      this.statusEl.style.display = 'none';
      return;
    }
    this.statusEl.style.display = 'block';
    this.statusEl.style.color =
      kind === 'error' ? '#ff7b72' : kind === 'warn' ? '#d29922' : '#79c0ff';
    this.statusEl.textContent = text;
  }

  update(profiler: Profiler, now = performance.now()): void {
    if (this.bodyEl === null) return;
    if (now - this.lastUpdate < this.updateIntervalMs) return;
    this.lastUpdate = now;

    const frame = profiler.lastFrame;
    const deltas = profiler.recorder.summaryOf('deltaMs');
    const cpu = profiler.recorder.summaryOf('cpuFrameMs');
    const gpu = profiler.recorder.gpuRenderSummary();

    const gpuLine =
      gpu === null
        ? profiler.timestampsAvailable
          ? 'gpu       尚無樣本'
          : 'gpu       不可得 (無 timestamp-query)'
        : `gpu       ${ms(gpu.p50)} p50   ${ms(gpu.p95)} p95   (${profiler.recorder.gpuSampleCount} 樣本)`;

    const early = profiler.recorder.earlyFrames();

    this.bodyEl.textContent = [
      `fps       ${fps(deltas.p50).padStart(6)}   1%low ${fps(deltas.p99)}`,
      `frame     ${ms(deltas.p50)} p50   ${ms(deltas.p95)} p95   ${ms(deltas.p99)} p99`,
      `cpu       ${ms(cpu.p50)} p50   ${ms(cpu.p95)} p95`,
      gpuLine,
      // 啟動成本在穩定期的統計裡完全看不到，必須單獨列出
      `early${String(early.count).padStart(3)}  ${ms(early.totalMs)} 總計   ${ms(early.worstMs)} 最慢`,
      '',
      `draws     ${int(frame.stats.drawCalls)}   tris ${int(frame.stats.triangles)}`,
      `compute   ${int(frame.stats.computeCalls)}   targets ${int(frame.stats.renderTargets)}`,
      `gpu mem   ${mb(frame.stats.memoryTotalBytes)}   peak ${mb(profiler.recorder.peakMemoryBytes)}`,
      `  drift   ${mb(profiler.recorder.memoryDriftBytes())}`,
      `  tex     ${mb(frame.stats.texturesBytes)}   attr ${mb(frame.stats.attributesBytes)}`,
      `js heap   ${frame.jsHeapUsedBytes === null ? 'n/a' : mb(frame.jsHeapUsedBytes)}`,
      `longtask  ${profiler.mainThread.totalLongTasks} 次 / ${ms(profiler.mainThread.totalLongTaskMs)}`,
      `frames    ${profiler.frameCount}`,
    ].join('\n');
  }

  dispose(): void {
    this.root?.remove();
  }
}

const ms = (value: number): string => (Number.isFinite(value) ? `${value.toFixed(2)}ms` : '   n/a');
const fps = (deltaMs: number): string =>
  Number.isFinite(deltaMs) && deltaMs > 0 ? (1000 / deltaMs).toFixed(1) : 'n/a';
const int = (value: number): string => (Number.isFinite(value) ? value.toFixed(0) : 'n/a');
const mb = (bytes: number): string =>
  Number.isFinite(bytes) ? `${(bytes / (1024 * 1024)).toFixed(1)}MB` : 'n/a';
