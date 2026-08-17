import type { Bytes, Milliseconds } from '@ww/core';

/**
 * diagnostics 不認識 Three.js —— 它定義介面，由 @ww/render-three 實作。
 * 這是「Three.js 只在 adapter 層」這條規則在實務上長什麼樣子。
 */

export interface RendererStatsSnapshot {
  /** 本幀 draw call 數。 */
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  /** 本幀 render pass 數。 */
  renderCalls: number;
  computeCalls: number;

  /** GPU 記憶體估計。對應working-set 預算。 */
  memoryTotalBytes: Bytes;
  texturesBytes: Bytes;
  attributesBytes: Bytes;
  storageBytes: Bytes;
  programsBytes: Bytes;
  renderTargets: number;
  textures: number;
  geometries: number;
  programs: number;
}

export const EMPTY_STATS: RendererStatsSnapshot = {
  drawCalls: 0,
  triangles: 0,
  points: 0,
  lines: 0,
  renderCalls: 0,
  computeCalls: 0,
  memoryTotalBytes: 0,
  texturesBytes: 0,
  attributesBytes: 0,
  storageBytes: 0,
  programsBytes: 0,
  renderTargets: 0,
  textures: 0,
  geometries: 0,
  programs: 0,
};

export interface GpuTimingSample {
  /**
   * 整幀的 GPU 時間。
   *
   * **這是 whole-frame，不是 per-pass。** Three.js 目前只透過
   * `resolveTimestampsAsync()` 提供整幀數字；要拆出 Shadow / Depth / Opaque / GI
   * 各自的時間，需要 Render Graph 自己管理 query set。
   *
   * backend 不支援 timestamp query 時為 null —— 注意是 null，不是 0。
   * 回傳 0 會讓「量不到」看起來像「非常快」。
   */
  renderMs: Milliseconds | null;
  computeMs: Milliseconds | null;
}

export const NO_GPU_TIMING: GpuTimingSample = { renderMs: null, computeMs: null };

export interface RendererTelemetry {
  /** backend 是否真的支援 timestamp query（feature 有宣告且已啟用）。 */
  readonly timestampsAvailable: boolean;
  readStats(): RendererStatsSnapshot;
  /** 非同步且落後數幀。不支援時回傳 NO_GPU_TIMING。 */
  resolveGpuTimings(): Promise<GpuTimingSample>;
}
