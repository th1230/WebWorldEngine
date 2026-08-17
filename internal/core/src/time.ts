import { assert } from './assert.ts';
import type { Seconds } from './types.ts';

export interface FixedTimestepConfig {
  /** 每個 simulation step 的長度。60 Hz = 1/60。 */
  stepSeconds: Seconds;
  /** 單幀最多執行幾步。這是 spiral of death 的保險絲。 */
  maxStepsPerFrame: number;
  /** 單幀 delta 的上限。分頁切回前景、中斷點續跑時 dt 會非常大。 */
  maxFrameSeconds: Seconds;
}

export const DEFAULT_FIXED_TIMESTEP: FixedTimestepConfig = {
  stepSeconds: 1 / 60,
  maxStepsPerFrame: 5,
  maxFrameSeconds: 0.25,
};

/**
 * Simulation 與 rendering 解耦的核心。
 *
 * Simulation 以固定步長前進，畫面以任意 FPS 呈現，兩者之間用 `alpha` 做內插：
 *
 *   renderTransform = lerp(previousSimTransform, currentSimTransform, accumulator.alpha)
 *
 * 這樣物理和角色行為不會隨 FPS 改變。
 *
 * 只交付數學與測試；真正接上 tick 迴圈是 Engine Kernel 的工作。
 */
export class FixedTimestepAccumulator {
  readonly config: FixedTimestepConfig;
  private accumulator = 0;
  private _droppedSteps = 0;
  private _clampedFrames = 0;
  private _totalSteps = 0;

  constructor(config: FixedTimestepConfig = DEFAULT_FIXED_TIMESTEP) {
    assert(config.stepSeconds > 0, 'stepSeconds 必須大於 0');
    assert(config.maxStepsPerFrame >= 1, 'maxStepsPerFrame 至少為 1');
    assert(
      config.maxFrameSeconds >= config.stepSeconds,
      'maxFrameSeconds 不可小於 stepSeconds，否則永遠跑不滿一步',
    );
    this.config = config;
  }

  /**
   * 餵入本幀經過的真實時間，回傳這一幀應該執行幾次 simulation step。
   *
   * 當機器慢到追不上時，多餘的時間會被「丟棄」而不是累積 —— 累積會讓下一幀要跑
   * 更多步、於是更慢、於是累積更多，這就是 spiral of death。丟棄的步數會被記錄，
   * 因為它代表 simulation 時間開始落後真實時間，是效能問題的訊號而非可忽略的細節。
   */
  advance(frameDeltaSeconds: Seconds): number {
    let dt = frameDeltaSeconds;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (dt > this.config.maxFrameSeconds) {
      dt = this.config.maxFrameSeconds;
      this._clampedFrames++;
    }

    this.accumulator += dt;

    let steps = Math.floor(this.accumulator / this.config.stepSeconds);
    if (steps > this.config.maxStepsPerFrame) {
      const dropped = steps - this.config.maxStepsPerFrame;
      this._droppedSteps += dropped;
      this.accumulator -= dropped * this.config.stepSeconds;
      steps = this.config.maxStepsPerFrame;
    }
    this.accumulator -= steps * this.config.stepSeconds;
    this._totalSteps += steps;
    return steps;
  }

  /** 目前累積量佔一步的比例，範圍 [0, 1)。用於 render 端內插。 */
  get alpha(): number {
    return this.accumulator / this.config.stepSeconds;
  }

  /** 因為追不上而被丟棄的步數。持續上升代表 simulation 超出預算。 */
  get droppedSteps(): number {
    return this._droppedSteps;
  }

  /** dt 被 maxFrameSeconds 截斷的次數（分頁切換、debugger 中斷）。 */
  get clampedFrames(): number {
    return this._clampedFrames;
  }

  get totalSteps(): number {
    return this._totalSteps;
  }

  /** 場景切換、teleport、device 恢復後呼叫，避免把停頓時間當成模擬時間補跑。 */
  reset(): void {
    this.accumulator = 0;
  }

  resetStats(): void {
    this._droppedSteps = 0;
    this._clampedFrames = 0;
    this._totalSteps = 0;
  }
}
