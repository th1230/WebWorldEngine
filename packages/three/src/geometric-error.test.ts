import { IcosahedronGeometry, PlaneGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { maxSurfaceDeviation } from '@web-world-engine/format';
import { sphericalLodErrors } from './spherical-error.ts';

/**
 * 被測的東西住在 `@web-world-engine/format`（那個套件沒有任何相依），測試住在這裡
 * ——因為驗它需要 Three 的幾何產生器當**獨立的參考實作**，而那是相依。
 *
 * 這支要證明的是「它量得準」，而準的判準是**拿有封閉解的幾何比對**，
 * 不是「跑起來沒爆」。
 *
 * 一個量誤差的東西自己不準，症狀是畫面比宣稱的糊而沒有任何錯誤 —— 跟它要
 * 取代的那個估計值一模一樣。所以它必須被更硬的東西驗過。
 */

function toMesh(geometry: { getAttribute: (n: string) => unknown; getIndex: () => unknown }): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  const position = geometry.getAttribute('position') as { array: ArrayLike<number>; count: number };
  const index = geometry.getIndex() as { array: ArrayLike<number> } | null;
  return {
    positions: Float32Array.from(position.array),
    indices:
      index === null
        ? Uint32Array.from({ length: position.count }, (_, i) => i)
        : Uint32Array.from(index.array),
  };
}

describe('量簡化網格真正偏離原始網格多遠', () => {
  it('同一份網格對自己是 0', () => {
    const mesh = toMesh(new IcosahedronGeometry(1, 2));
    expect(maxSurfaceDeviation(mesh.positions, mesh)).toBeLessThan(1e-5);
  });

  it('平面細分成幾份之後仍然是 0 —— 頂點變少不代表形狀變了', () => {
    // 這一條擋的是「拿最近**頂點**的距離當答案」那種便宜作法：粗平面的頂點
    // 離細平面的頂點很遠，但兩者的**表面完全重合**，正確答案是 0。
    const fine = toMesh(new PlaneGeometry(2, 2, 8, 8));
    const coarse = toMesh(new PlaneGeometry(2, 2, 1, 1));
    expect(maxSurfaceDeviation(fine.positions, coarse)).toBeLessThan(1e-5);
  });

  it('平移一段距離就量到那段距離', () => {
    const mesh = toMesh(new PlaneGeometry(2, 2, 4, 4));
    const moved = { ...mesh, positions: Float32Array.from(mesh.positions) };
    for (let i = 2; i < moved.positions.length; i += 3) moved.positions[i]! += 0.25;
    expect(maxSurfaceDeviation(mesh.positions, moved)).toBeCloseTo(0.25, 4);
  });

  it('icosphere 上永遠不低於矢高差 —— 而且本來就該更大', () => {
    // ## 為什麼不是「相符」而是「不低於」
    //
    // `sphericalLodErrors` 比的是**兩階各自的矢高之差**，這一支比的是
    // 「細階的頂點離粗階表面多遠」。兩者不是同一個量：
    //
    // 細階的頂點在球面上，而細階的**面**是內凹的（矢高就是那個內凹）。
    // 所以從頂點量到粗階表面時，量到的距離裡也包含了細階自己那份鼓起。
    //
    // 對品質契約來說，**這一支量的才是對的**：契約在意的是「換成粗階之後
    // 畫面上的東西移動了多少」，而畫面上的輪廓是由頂點決定的，不是由矢高差。
    //
    // 實測 detail 3：矢高差 0.0063，這一支量到 0.0165。差的那一份正是
    // detail 4 自己的矢高。**也就是 `sphericalLodErrors` 本身也是低估的**，
    // 只是它低估的是一個已知且有界的量。
    const fine = new IcosahedronGeometry(1, 4);
    for (const detail of [3, 2, 1, 0]) {
      const coarse = new IcosahedronGeometry(1, detail);
      const sagittaGap = sphericalLodErrors([fine, coarse])[1]!;
      const measured = maxSurfaceDeviation(toMesh(fine).positions, toMesh(coarse));

      // 低估才是危險的方向（選到太粗的階，畫面比宣稱的糊）。
      expect(measured, `detail ${detail}`).toBeGreaterThanOrEqual(sagittaGap);
      // 但也不能離譜 —— 差距的來源是細階自己的矢高，而那是有界的。
      // 粗階越粗，兩者越接近（那份固定的偏移佔比越小）。
      expect(measured, `detail ${detail}`).toBeLessThan(sagittaGap + 0.011);
    }
  });

  it('空的簡化網格回傳 0 而不是爆掉', () => {
    const mesh = toMesh(new IcosahedronGeometry(1, 1));
    expect(
      maxSurfaceDeviation(mesh.positions, {
        positions: mesh.positions,
        indices: new Uint32Array(0),
      }),
    ).toBe(0);
  });

  it('十萬個頂點對五千個三角形要在一秒內量完', () => {
    // 沒有空間格的話這是 5 億次點對三角形，LOD 產生會從幾毫秒變成幾十秒。
    // 這一條是在擋「格子被改壞了但結果還對」——那種退化只有時間看得出來。
    const fine = toMesh(new IcosahedronGeometry(1, 40));
    const coarse = toMesh(new IcosahedronGeometry(1, 4));
    expect(fine.positions.length / 3).toBeGreaterThan(100_000);
    const started = performance.now();
    maxSurfaceDeviation(fine.positions, coarse);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
