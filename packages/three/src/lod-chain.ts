import type { BufferGeometry } from 'three';

/**
 * 使用者自備的 LOD 鏈。
 *
 * `lods[0]` 是最細的一階，`errors[i]` 是第 i 階相對 `lods[0]` 的幾何誤差，
 * **世界單位**。
 */
export interface LodChain {
  readonly lods: readonly BufferGeometry[];
  /**
   * 每一階的幾何誤差，世界單位。長度必須與 `lods` 相同，`errors[0]` 必須是 0。
   *
   * ## 為什麼這是必填的
   *
   * 螢幕誤差選階的整套品質保證（「被選中的階投影到螢幕上誤差 ≤ 2 像素」）
   * 完全建立在這個數字上。沒有它就只能猜，而猜出來的門檻會在兩個方向上
   * 都出錯：猜大了畫面糊掉，猜小了白花三角形 —— 兩種都不會報錯。
   *
   * 用簡化器產生 LOD 鏈時這個數字是現成的（它就是簡化的停止條件）。
   * 手工做的鏈可以用「被移除的最長邊」或「兩階之間的最大頂點位移」量。
   *
   * 只給一階幾何（不傳 `lods`）是完全合法的 —— 那就沒有 LOD，也不需要
   * 這個數字。
   */
  readonly errors: readonly number[];
}

export type GeometrySource = BufferGeometry | LodChain;

export function isLodChain(source: GeometrySource): source is LodChain {
  return (source as LodChain).lods !== undefined;
}

/** 展開成一組幾何加一組誤差，並檢查所有前置條件。 */
export function resolveLodChain(source: GeometrySource): {
  geometries: BufferGeometry[];
  errors: Float32Array;
  /** 只給了一份幾何，所以這條鏈是可以自動補的。 */
  canAutoGenerate: boolean;
} {
  if (!isLodChain(source)) {
    return { geometries: [source], errors: new Float32Array(1), canAutoGenerate: true };
  }

  const { lods, errors } = source;
  if (lods.length === 0) {
    throw new Error('WW.InstancedMesh: lods 是空的。至少要有一階幾何。');
  }
  if (errors === undefined) {
    throw new Error(
      'WW.InstancedMesh: 給了 lods 就必須一併給 errors（每一階的幾何誤差，世界單位）。\n' +
        '螢幕誤差選階的品質保證建立在這個數字上，沒有它只能猜，而猜錯不會報錯。\n' +
        '若你只想要單一階幾何，直接傳 BufferGeometry 即可。',
    );
  }
  if (errors.length !== lods.length) {
    throw new Error(
      `WW.InstancedMesh: errors 有 ${errors.length} 筆，lods 有 ${lods.length} 階，數量必須相同。`,
    );
  }
  if (errors[0] !== 0) {
    throw new Error(
      `WW.InstancedMesh: errors[0] 必須是 0（第 0 階就是原始幾何，相對自己沒有誤差），收到 ${errors[0]}。`,
    );
  }
  for (let i = 1; i < errors.length; i++) {
    if (!(errors[i]! > errors[i - 1]!)) {
      throw new Error(
        `WW.InstancedMesh: errors 必須嚴格遞增（index 0 最細）。errors[${i}] = ${errors[i]} 不大於 errors[${i - 1}] = ${errors[i - 1]}。`,
      );
    }
  }

  // 使用者自己給了鏈就不再自動補。他比我們更清楚那些階是怎麼來的，
  // 而在後面接上一條演算法產生的尾巴會讓誤差的來源變成兩種。
  return { geometries: [...lods], errors: Float32Array.from(errors), canAutoGenerate: false };
}

/**
 * 依螢幕空間誤差挑一階：回傳誤差投影後仍 ≤ `errorPixels` 的**最粗**一階。
 *
 * ## 為什麼是螢幕誤差而不是距離
 *
 * `THREE.LOD` 用的是原始距離 —— 不看物件多大、不看 fov、不看視埠高度。
 * 同一個距離上，一顆放大六倍的石頭和一顆原尺寸的該用的階差好幾級，
 * 依距離選會讓大物件過早變粗（看得出來）而小物件過晚變粗（白花三角形）。
 *
 * @param errors 每階的世界單位誤差，遞增。
 * @param perMetre 這個 instance 上「世界 1 單位 → 幾像素」的換算率，
 *   即 `scale / distance * pixelsPerUnit`。
 */
export function selectLevel(errors: Float32Array, perMetre: number, errorPixels: number): number {
  for (let level = errors.length - 1; level > 0; level--) {
    if (errors[level]! * perMetre <= errorPixels) return level;
  }
  return 0;
}

/** 世界空間 1 單位的物體在 1 單位距離處佔多少像素。 */
export function pixelsPerUnit(viewportHeight: number, fovYRadians: number): number {
  return viewportHeight / (2 * Math.tan(fovYRadians / 2));
}
