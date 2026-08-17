import type { Profiler, StatsOverlay } from '@ww/diagnostics';
import { buildReport, type BenchmarkReport, type ReportMeta } from '@ww/diagnostics';
import type { ThreeRenderBackend } from '@ww/render-three';
import type { BenchmarkScene } from './scenes/types.ts';

export type HarnessPhase = 'booting' | 'warmup' | 'measuring' | 'done' | 'failed' | 'interactive';

/** Playwright runner 會輪詢 `window.__wwBenchmark` 讀取這個狀態。 */
export interface HarnessState {
  phase: HarnessPhase;
  sceneId: string;
  framesDone: number;
  framesTotal: number;
  report: BenchmarkReport | null;
  error: string | null;
}

declare global {
  interface Window {
    __wwBenchmark?: HarnessState;
  }
}

export interface HarnessOptions {
  backend: ThreeRenderBackend;
  profiler: Profiler;
  overlay: StatsOverlay;
  scene: BenchmarkScene;
  sceneId: string;
  warmupFrames: number;
  measureFrames: number;
  /** true 時跑完固定幀數就停下並產生報告；false 則持續執行供人觀察。 */
  autorun: boolean;
  buildMeta: (scene: BenchmarkScene) => ReportMeta;
}

export function createHarnessState(sceneId: string): HarnessState {
  const state: HarnessState = {
    phase: 'booting',
    sceneId,
    framesDone: 0,
    framesTotal: 0,
    report: null,
    error: null,
  };
  window.__wwBenchmark = state;
  return state;
}

/**
 * 量測迴圈。
 *
 * 兩段式：先跑暖機幀然後**丟棄**，再開始記錄。暖機是為了把 shader 編譯、
 * 首次資源上傳、以及瀏覽器自己的暖身排除在數字之外 —— 除非場景明確表示
 * 它要量的就是那段成本（`overrideWarmupFrames: 0`）。
 */
export function runHarness(options: HarnessOptions, state: HarnessState): Promise<BenchmarkReport | null> {
  const { backend, profiler, overlay, scene, warmupFrames, measureFrames, autorun } = options;

  const totalWarmup = scene.overrideWarmupFrames ?? warmupFrames;
  state.framesTotal = totalWarmup + measureFrames;
  state.phase = totalWarmup > 0 ? 'warmup' : 'measuring';

  return new Promise((resolve) => {
    let frame = 0;
    let measuring = totalWarmup === 0;
    let stopped = false;

    const tick = (): void => {
      if (stopped) return;

      // 量測索引從 0 重新起算，讓相機路徑在正式量測時剛好走完規劃的一圈
      const sceneFrame = measuring ? frame - totalWarmup : frame;

      profiler.beginFrame();
      scene.update(sceneFrame);
      // 場景自己決定怎麼提交：引擎場景走 RenderFrame，renderer benchmark 走 submitRaw
      scene.render(backend);
      profiler.endFrame();

      overlay.update(profiler);

      frame++;
      state.framesDone = frame;

      if (!measuring && frame >= totalWarmup) {
        // 丟棄暖機資料，從乾淨的歷史開始
        profiler.reset();
        measuring = true;
        // 互動模式沒有「量測階段」可言，別把 phase 從 interactive 蓋掉
        if (autorun) state.phase = 'measuring';
      }

      if (autorun && frame >= totalWarmup + measureFrames) {
        stopped = true;
        finish();
        return;
      }

      requestAnimationFrame(tick);
    };

    const finish = (): void => {
      // 多等一幀讓最後幾個非同步的 GPU timestamp 解析回來
      requestAnimationFrame(() => {
        const report = buildReport(profiler, options.buildMeta(scene));
        state.report = report;
        state.phase = 'done';
        overlay.setStatus(`量測完成：${report.frames} 幀`, 'info');
        resolve(report);
      });
    };

    if (!autorun) {
      state.phase = 'interactive';
      overlay.setStatus('互動模式：持續執行中（加上 ?autorun=1 可產生報告）', 'info');
      requestAnimationFrame(tick);
      resolve(null);
      return;
    }

    requestAnimationFrame(tick);
  });
}
