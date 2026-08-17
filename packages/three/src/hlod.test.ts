import { BoxGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { mergeInstances, mergedSize } from './hlod.ts';

/**
 * 合併幾何壞掉的樣子幾乎都是**畫面怪怪的**，不是報錯：
 *
 * - 索引沒有平移 → 每一份都畫成第一份，整片重疊
 * - 法線用 3×3 而不是逆轉置 → 非等比縮放的物件光照偏掉
 * - 頂點超過 65535 還用 16-bit 索引 → 幾何變成一團亂線
 * - 座標烘成絕對值 → 遠離原點的地方頂點互相塌陷
 *
 * 所以這裡驗的是幾何本身的數值，不是「有沒有跑完」。
 */

/** 一組矩陣，攤平成 `BatchedMesh` 的佈局。 */
function matricesOf(...list: Matrix4[]): Float32Array {
  const out = new Float32Array(list.length * 16);
  list.forEach((m, i) => out.set(m.elements, i * 16));
  return out;
}

const ALL = (n: number): Uint32Array => Uint32Array.from({ length: n }, (_, i) => i);

describe('mergeInstances', () => {
  it('頂點數與索引數是每份的總和', () => {
    const box = new BoxGeometry(1, 1, 1).toNonIndexed();
    box.setIndex(Array.from({ length: box.getAttribute('position').count }, (_, i) => i));

    const merged = mergeInstances(
      box,
      matricesOf(new Matrix4(), new Matrix4().makeTranslation(10, 0, 0)),
      ALL(2),
      0,
      2,
    )!;

    const one = mergedSize(box, 1);
    expect(merged.geometry.getAttribute('position').count).toBe(one.vertices * 2);
    expect(merged.geometry.getIndex()!.count).toBe(one.indices * 2);
  });

  it('每一份的索引都平移到自己的頂點區段', () => {
    const box = new BoxGeometry(1, 1, 1);
    const vertices = box.getAttribute('position').count;

    const merged = mergeInstances(
      box,
      matricesOf(new Matrix4(), new Matrix4().makeTranslation(10, 0, 0)),
      ALL(2),
      0,
      2,
    )!;

    const indices = merged.geometry.getIndex()!;
    const half = indices.count / 2;
    // 沒平移的話第二份會畫在第一份的頂點上 —— 兩份完全重疊，而數量正確。
    for (let i = 0; i < half; i++) expect(indices.getX(i)).toBeLessThan(vertices);
    for (let i = half; i < indices.count; i++) expect(indices.getX(i)).toBeGreaterThanOrEqual(vertices);
  });

  it('位置是相對中心的，中心另外回傳', () => {
    const box = new BoxGeometry(1, 1, 1);
    const merged = mergeInstances(
      box,
      matricesOf(
        new Matrix4().makeTranslation(1000, 0, 0),
        new Matrix4().makeTranslation(1010, 0, 0),
      ),
      ALL(2),
      0,
      2,
    )!;

    // 中心是兩個位置的平均。烘絕對座標的話，float32 在遠處的間距會讓
    // 頂點開始塌陷，而那看起來只是「遠方的東西髒髒的」。
    expect(merged.center[0]).toBeCloseTo(1005, 4);

    const position = merged.geometry.getAttribute('position');
    for (let v = 0; v < position.count; v++) {
      expect(Math.abs(position.getX(v))).toBeLessThan(6);
    }
  });

  it('平移之後的世界座標與原本一致', () => {
    const box = new BoxGeometry(2, 2, 2);
    const matrix = new Matrix4().compose(
      new Vector3(30, 4, -7),
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.9),
      new Vector3(1.5, 1.5, 1.5),
    );
    const merged = mergeInstances(box, matricesOf(matrix), ALL(1), 0, 1)!;

    const source = box.getAttribute('position');
    const baked = merged.geometry.getAttribute('position');
    const expected = new Vector3();
    for (let v = 0; v < source.count; v++) {
      expected.fromBufferAttribute(source, v).applyMatrix4(matrix);
      expect(baked.getX(v) + merged.center[0]).toBeCloseTo(expected.x, 3);
      expect(baked.getY(v) + merged.center[1]).toBeCloseTo(expected.y, 3);
      expect(baked.getZ(v) + merged.center[2]).toBeCloseTo(expected.z, 3);
    }
  });

  it('非等比縮放的法線走逆轉置，不是 3×3', () => {
    const box = new BoxGeometry(1, 1, 1);
    // 只壓扁 y。3×3 直接乘會讓斜面的法線往壓扁的方向偏。
    const squashed = new Matrix4().makeScale(1, 0.1, 1);
    const rotated = new Matrix4()
      .makeRotationZ(Math.PI / 4)
      .premultiply(squashed);

    const merged = mergeInstances(box, matricesOf(rotated), ALL(1), 0, 1)!;
    const normal = merged.geometry.getAttribute('normal');

    // 取原始法線是 (1,0,0) 的那個頂點，比對「逆轉置」與「直接乘 3×3」。
    // 兩者在非等比縮放下會明顯分岔，而畫面上只是「光照怪怪的」。
    const source = box.getAttribute('normal');
    const naive = new Vector3(1, 0, 0).transformDirection(rotated);
    let checked = 0;
    for (let v = 0; v < source.count; v++) {
      if (source.getX(v) !== 1) continue;
      const got = new Vector3(normal.getX(v), normal.getY(v), normal.getZ(v));
      expect(got.length()).toBeCloseTo(1, 4);
      expect(got.angleTo(naive)).toBeGreaterThan(0.05);
      checked++;
      break;
    }
    expect(checked).toBe(1);
  });

  it('頂點超過 65535 時改用 32-bit 索引', () => {
    const box = new BoxGeometry(1, 1, 1); // 24 個頂點
    const instances = 3000; // 72,000 個頂點
    const merged = mergeInstances(
      box,
      new Float32Array(instances * 16).map((_, i) => (i % 16 === 0 || i % 16 === 5 || i % 16 === 10 || i % 16 === 15 ? 1 : 0)),
      ALL(instances),
      0,
      instances,
    )!;

    // 16-bit 會靜靜地繞回去，幾何變成一團亂線。
    expect(merged.geometry.getIndex()!.array).toBeInstanceOf(Uint32Array);
  });

  it('空範圍回傳 null 而不是空幾何', () => {
    const box = new BoxGeometry(1, 1, 1);
    expect(mergeInstances(box, new Float32Array(16), ALL(1), 0, 0)).toBeNull();
  });
});
