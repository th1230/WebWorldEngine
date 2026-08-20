import type { AssetId } from '@web-world-engine/format';
import type { FrameId } from '@ww/core';

/**
 * RenderFrame：simulation 與 rendering 之間唯一的介面。
 *
 * 這裡**完全沒有 renderer 的型別**——沒有 Object3D、沒有 Mesh、沒有 Camera。
 * 一幀畫面被描述成純資料，因此換 backend 不需要改動引擎的任何一行。
 *
 * ## 生命週期
 *
 * frame 對消費端是**唯讀**的，而且**只在下一次抽取之前有效**。
 *
 * 規格說「快照生成後不再修改」，字面上的完全不可變意味著每幀配置數 MB 的
 * 矩陣資料。實際做法是重複使用緩衝區並嚴格規定所有權：抽取端在發佈之後
 * 不得再寫入，消費端不得保留參考跨越幀邊界。這條規則由型別（readonly）
 * 表達，並在此明文記錄。
 *
 * ## Camera-relative
 *
 * 所有 instance 矩陣都是**相對於相機**的 float32，不是世界座標。
 * 世界座標到了幾百萬公尺會超出 float32 精度而開始抖動；
 * 相機附近的相對座標則永遠落在精度充足的範圍內。
 * 相機自己的世界位置以 float64 另外攜帶。
 */

export interface CameraSnapshot {
  /** 相機的世界座標（f64，3 個分量）。所有 instance 矩陣都以此為原點。 */
  readonly worldPosition: Float64Array;
  /** 相機旋轉，四元數 (x, y, z, w)。 */
  readonly rotation: Float32Array;
  readonly fovYRadians: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
}

/**
 * 一批共用 mesh 與 material 的 instance。
 *
 * 分批是抽取階段的工作：ECS 裡的 entity 是散的，但 GPU 要的是
 * 「同一個 mesh + 同一個 material 的一大塊矩陣」。
 */
export interface RenderBatch {
  readonly meshAsset: AssetId;
  readonly materialAsset: AssetId;
  readonly count: number;
  /**
   * `count × 16` 個 float，column-major 的 4×4 矩陣，**相對於相機**。
   *
   * 這是一個涵蓋整個緩衝區的視圖，長度可能大於 `count * 16`；
   * 只有前 `count * 16` 個元素有效。
   */
  readonly matrices: Float32Array;
}

export type RenderLightKind = 'directional' | 'point' | 'ambient';

export interface RenderLight {
  readonly kind: RenderLightKind;
  /** directional 用方向，point 用相機相對位置；ambient 忽略。 */
  readonly vector: Float32Array;
  readonly color: Float32Array;
  readonly intensity: number;
}

export interface RenderFrameStats {
  /** 世界中存活的 entity 總數。 */
  readonly entities: number;
  /** 通過抽取條件、真的會被畫的 instance 數。 */
  readonly visibleInstances: number;
  /** 因為缺少必要 component 而被跳過的 renderable 數。 */
  readonly skipped: number;
  /**
   * 被視錐剔除掉的 instance 數。
   *
   * 這是可見性系統唯一的成效指標。開放世界裡它應該遠大於 visibleInstances ——
   * 若兩者接近，代表剔除幾乎沒有作用（相機視角太廣、世界太集中、
   * 或是根本沒設定包圍體，見 unbounded）。
   */
  readonly culled: number;
  /**
   * 沒有包圍體、因此**未經剔除就直接繪製**的 instance 數。
   *
   * 必須被看見：它不為 0 代表有一部分世界完全繞過了可見性系統，
   * 而畫面看起來會完全正常。
   */
  readonly unbounded: number;
  readonly batches: number;
}

export interface RenderFrame {
  readonly frameId: FrameId;
  /** 已執行的 simulation step 數，供 replay 與偵錯對齊。 */
  readonly tick: number;
  /** Simulation 內插係數 [0, 1)，抽取時已套用到矩陣上。 */
  readonly alpha: number;
  readonly camera: CameraSnapshot;
  readonly batches: readonly RenderBatch[];
  readonly lights: readonly RenderLight[];
  readonly stats: RenderFrameStats;
}
