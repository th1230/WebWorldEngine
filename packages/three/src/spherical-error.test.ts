import { BoxGeometry, IcosahedronGeometry, SphereGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { sphericalLodErrors } from './spherical-error.ts';

describe('sphericalLodErrors', () => {
  it('最細的一階誤差是 0', () => {
    const errors = sphericalLodErrors([new IcosahedronGeometry(1, 4)]);
    expect(errors).toEqual([0]);
  });

  it('越粗的階誤差越大', () => {
    const errors = sphericalLodErrors([
      new IcosahedronGeometry(1, 4),
      new IcosahedronGeometry(1, 2),
      new IcosahedronGeometry(1, 1),
    ]);

    expect(errors[0]).toBe(0);
    expect(errors[1]).toBeGreaterThan(0);
    expect(errors[2]).toBeGreaterThan(errors[1]!);
  });

  it('量出來的值與已知的幾何常數相符', () => {
    // 正二十面體的內切半徑 / 外接半徑 = 0.7946545…，所以面心的矢高
    // 就是 1 − 0.79465 = 0.20535。這是一個獨立於本實作的已知常數。
    const [, coarse] = sphericalLodErrors([
      new IcosahedronGeometry(1, 4),
      new IcosahedronGeometry(1, 0),
    ]);

    const icosahedronSagitta = 1 - 0.7946545;
    const detail4Sagitta = 0.011471;
    expect(coarse).toBeCloseTo(icosahedronSagitta - detail4Sagitta, 4);
  });

  it('公式推導會低估 —— 這就是為什麼要量', () => {
    // 舊版用「邊長球心角每細分一次折半」推，得到 detail 2 的誤差 0.0128。
    // 實測是 0.0169，低估 24%。低估的方向是**選到太粗的階**，也就是靜靜地
    // 違反品質契約 —— 沒有東西會報錯，只是畫面比宣稱的糊。
    const [, detail2] = sphericalLodErrors([
      new IcosahedronGeometry(1, 4),
      new IcosahedronGeometry(1, 2),
    ]);

    expect(detail2).toBeGreaterThan(0.0128 * 1.2);
    expect(detail2).toBeCloseTo(0.0169, 3);
  });

  it('半徑會等比縮放誤差', () => {
    const one = sphericalLodErrors([new IcosahedronGeometry(1, 4), new IcosahedronGeometry(1, 1)]);
    const ten = sphericalLodErrors(
      [new IcosahedronGeometry(10, 4), new IcosahedronGeometry(10, 1)],
      10,
    );

    expect(ten[1]).toBeCloseTo(one[1]! * 10, 4);
  });

  it('有索引的幾何也算得出來', () => {
    // IcosahedronGeometry 是非索引的，SphereGeometry 有索引 —— 兩條路徑
    // 都要走過，否則其中一條會在第一次真的用到時才爆。
    const errors = sphericalLodErrors([new SphereGeometry(1, 32, 24), new SphereGeometry(1, 8, 6)]);

    expect(errors[0]).toBe(0);
    expect(errors[1]).toBeGreaterThan(0);
  });

  it('非球面的幾何算出來的數字沒有意義 —— 呼叫端要負責', () => {
    // 立方體的頂點不在內接球上，所以「面心到球心的距離」量到的是別的東西。
    // 這個測試不是在驗證正確，而是釘住這個函式的**適用範圍**：
    // 它回傳一個看起來很正常的數字，不會報錯。
    const errors = sphericalLodErrors([new BoxGeometry(1, 1, 1), new BoxGeometry(2, 2, 2)]);
    expect(Number.isFinite(errors[1])).toBe(true);
  });
});
