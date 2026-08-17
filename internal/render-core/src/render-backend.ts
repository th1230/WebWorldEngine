import type { CapabilityProfile } from '@ww/core';
import type { RendererTelemetry } from '@ww/diagnostics';
import type { RenderFrame } from './render-frame.ts';

/**
 * Renderer backend 的抽象介面。
 *
 * 這個 package 是「Three.js 只在 adapter 層」這條規則的接縫：引擎其他部分只
 * 認識這裡的介面與 RenderFrame，@ww/render-three 提供唯一的實作。
 *
 * 之後這個介面**不再對 scene / camera 型別泛型化**。時它是
 * `RenderBackend<TScene, TCamera>`，因為呼叫端還是直接把 Three.js 的 Scene
 * 交下來；現在一幀畫面被 RenderFrame 完整描述成資料，backend 不需要知道
 * 上游用什麼型別表示世界。這正是 的通過條件。
 */

export interface RenderBackendConfig {
  canvas: HTMLCanvasElement;
  /** 強制走 WebGL2，用來 A/B 驗證降級路徑。 */
  forceWebGL?: boolean | undefined;
  /**
   * 啟用 GPU timestamp query。
   * backend 若不支援會自動關閉，因此打開它不保證真的量得到。
   */
  trackTimestamp?: boolean | undefined;
  antialias?: boolean | undefined;
  samples?: number | undefined;
  pixelRatio?: number | undefined;
}

export interface RenderBackend {
  /** 必須在任何其他呼叫之前 await 完成。 */
  init(): Promise<void>;
  readonly initialized: boolean;
  readonly capabilities: CapabilityProfile;
  readonly telemetry: RendererTelemetry;

  resize(width: number, height: number, pixelRatio?: number): void;

  /**
   * 提交一幀。
   *
   * backend 不得保留 `frame` 的參考 —— 它的緩衝區會在下一次抽取時被覆寫。
   * 需要跨幀保存的資料必須自行複製。
   */
  submit(frame: RenderFrame): void;

  /**
   * 預先編譯這一幀會用到的材質，避免第一次看到新 shader 時的 compilation stutter。
   * 對應permutation 風險；實測顯示未預編譯會造成秒級停頓。
   */
  precompile(frame: RenderFrame): Promise<void>;

  /** 主動釋放 GPU 資源。GPU 記憶體不會等 JavaScript GC。 */
  dispose(): void;
}
