import {
  EMPTY_STATS,
  NO_GPU_TIMING,
  type GpuTimingSample,
  type RendererStatsSnapshot,
  type RendererTelemetry,
} from '@ww/diagnostics';
import type { WebGPURenderer } from 'three/webgpu';

/**
 * 把 Three.js 的 `renderer.info` 轉成 @ww/diagnostics 定義的中立格式。
 *
 * 這個 adapter 是「Three.js 只在 renderer 層」在實務上的樣子：diagnostics 完全
 * 不認識 WebGPURenderer，只認識 RendererTelemetry 這個介面。
 */
export class ThreeTelemetry implements RendererTelemetry {
  constructor(
    private readonly renderer: WebGPURenderer,
    readonly timestampsAvailable: boolean,
  ) {}

  readStats(): RendererStatsSnapshot {
    const { render, compute, memory } = this.renderer.info;
    return {
      drawCalls: render.drawCalls,
      triangles: render.triangles,
      points: render.points,
      lines: render.lines,
      renderCalls: render.frameCalls,
      computeCalls: compute.frameCalls,

      memoryTotalBytes: memory.total,
      texturesBytes: memory.texturesSize,
      // geometry 由頂點屬性與索引屬性共同構成
      attributesBytes: memory.attributesSize + memory.indexAttributesSize,
      storageBytes: memory.storageAttributesSize + memory.indirectStorageAttributesSize,
      programsBytes: memory.programsSize,
      renderTargets: memory.renderTargets,
      textures: memory.textures,
      geometries: memory.geometries,
      programs: memory.programs,
    };
  }

  /**
   * 只有整幀的 GPU 時間。
   *
   * Three.js 的 `resolveTimestampsAsync()` 回報的是整個 render（或 compute）的
   * 總時間，不是逐 pass 拆解。要拆出 Shadow / Depth / Opaque / GI 各自的耗時，
   * 需要我們自己的 Render Graph 管理 query set —— 那是 的工作。
   */
  async resolveGpuTimings(): Promise<GpuTimingSample> {
    if (!this.timestampsAvailable) return NO_GPU_TIMING;

    let renderMs: number | null = null;
    let computeMs: number | null = null;

    try {
      await this.renderer.resolveTimestampsAsync('render');
      renderMs = finiteOrNull(this.renderer.info.render.timestamp);
    } catch {
      // 解析失敗就維持 null。回傳 0 會讓「量不到」看起來像「非常快」。
    }

    // 這一幀若完全沒有 compute pass，解析會失敗或無意義；那不是錯誤
    if (this.renderer.info.compute.frameCalls > 0) {
      try {
        await this.renderer.resolveTimestampsAsync('compute');
        computeMs = finiteOrNull(this.renderer.info.compute.timestamp);
      } catch {
        // 同上
      }
    }

    return { renderMs, computeMs };
  }
}

/** renderer 尚未建立或已釋放時使用。回報 0 統計、null 時間。 */
export const NULL_TELEMETRY: RendererTelemetry = {
  timestampsAvailable: false,
  readStats: () => EMPTY_STATS,
  resolveGpuTimings: () => Promise.resolve(NO_GPU_TIMING),
};

function finiteOrNull(value: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
