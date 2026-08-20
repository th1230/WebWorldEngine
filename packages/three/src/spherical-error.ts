import type { BufferGeometry } from 'three';

/**
 * 量出一組**內接於同一球面**的多面體，各自相對最細那一階的幾何誤差。
 *
 * ## 這不是通用的簡化誤差量測
 *
 * 通用的版本要算兩個網格之間的 Hausdorff 距離（每個點到另一個曲面的最近
 * 距離），那是 W2 簡化器的工作。這裡只處理一個特例：**所有階的頂點都在
 * 同一個球面上**（`IcosahedronGeometry`、`SphereGeometry` 這類）。
 *
 * 那個特例下誤差有封閉解 —— 面心到球心的距離與半徑的差，也就是矢高。
 *
 * ## 為什麼要量而不是套公式
 *
 * 我第一版是用公式推的：「二十面體的邊長對應球心角 63.43°，每細分一次
 * 減半」。**兩個地方都錯了** —— `PolyhedronGeometry` 是把每條邊切成
 * `detail + 1` 段而不是折半，而且三角形的最深點不在外接圓上。
 *
 * 結果是 detail 2 的誤差被低估 24%（0.0128 對實測 0.0169）。
 * **低估誤差的方向是會選到太粗的階**，也就是靜靜地違反品質契約 ——
 * 沒有任何東西會報錯，只是畫面比宣稱的糊。
 *
 * 從實際的幾何量出來就沒有這個問題。它只在建構時跑一次。
 *
 * @param geometries index 0 必須是最細的一階。
 * @param radius 這些多面體內接的球半徑。
 * @returns 每一階相對 index 0 的誤差，世界單位。`[0]` 一定是 0。
 */
export function sphericalLodErrors(geometries: readonly BufferGeometry[], radius = 1): number[] {
  const sagittae = geometries.map((geometry) => maxSagitta(geometry, radius));
  const finest = sagittae[0] ?? 0;
  return sagittae.map((s, i) => (i === 0 ? 0 : Math.max(s - finest, 0)));
}

/** 所有面裡，面心離球面最遠的那一個的距離。 */
function maxSagitta(geometry: BufferGeometry, radius: number): number {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const faces = (index === null ? position.count : index.count) / 3;

  let deepest = 0;
  for (let face = 0; face < faces; face++) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let corner = 0; corner < 3; corner++) {
      const slot = face * 3 + corner;
      const vertex = index === null ? slot : index.getX(slot);
      x += position.getX(vertex);
      y += position.getY(vertex);
      z += position.getZ(vertex);
    }
    const gap = radius - Math.hypot(x / 3, y / 3, z / 3);
    if (gap > deepest) deepest = gap;
  }
  return deepest;
}
