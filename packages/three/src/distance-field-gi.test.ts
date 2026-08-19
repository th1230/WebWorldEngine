import { describe, expect, it } from 'vitest';
import { BoxGeometry, PlaneGeometry, Vector3 } from 'three';
import { DistanceFieldVolume } from './distance-field-gi.ts';

describe('距離場：算得出鏡頭外的遮蔽', () => {
  const boxVolume = (): DistanceFieldVolume =>
    new DistanceFieldVolume(new BoxGeometry(10, 10, 10), { resolution: 32, padding: 1 });

  it('盒子裡是負的、外面是正的', () => {
    const v = boxVolume();
    expect(v.distanceAt(new Vector3(0, 0, 0))).toBeLessThan(0);
    expect(v.distanceAt(new Vector3(14, 0, 0))).toBeGreaterThan(0);
  });

  it('朝著盒子走會被擋住，背對它不會', () => {
    // 這是整個東西存在的理由：**同一點、不同方向，答案要不一樣**。
    // 兩邊一樣的話它就只是一個環境光遮蔽的常數，那沒有用。
    const v = boxVolume();
    const outside = new Vector3(9, 0, 0);
    const toward = v.occlusionAlong(outside, new Vector3(-1, 0, 0));
    const away = v.occlusionAlong(outside, new Vector3(1, 0, 0));
    expect(toward).toBeGreaterThan(away);
    expect(toward).toBeGreaterThan(0.5);
  });

  it('離得越遠遮蔽越少', () => {
    const v = boxVolume();
    const near = v.occlusionAlong(new Vector3(6, 0, 0), new Vector3(-1, 0, 0));
    const far = v.occlusionAlong(new Vector3(14, 0, 0), new Vector3(-1, 0, 0));
    expect(near).toBeGreaterThanOrEqual(far);
  });

  it('空曠的方向遮蔽接近 0', () => {
    const v = boxVolume();
    // 往上走，盒子在旁邊而不是前面。
    const up = v.occlusionAlong(new Vector3(12, 0, 0), new Vector3(0, 1, 0));
    expect(up).toBeLessThan(0.5);
  });

  it('沒有 position 就擋下來', () => {
    const geometry = new PlaneGeometry(1, 1);
    geometry.deleteAttribute('position');
    expect(() => new DistanceFieldVolume(geometry)).toThrow(/position/);
  });

  it('遮蔽值永遠在 0 到 1 之間', () => {
    // 超出範圍的話它乘到間接光上會變成放大器或負光，而兩種都不會報錯。
    const v = boxVolume();
    for (const dir of [
      new Vector3(-1, 0, 0),
      new Vector3(1, 0, 0),
      new Vector3(0, 1, 0),
      new Vector3(0.577, 0.577, 0.577),
    ]) {
      for (const at of [new Vector3(6, 0, 0), new Vector3(0, 0, 0), new Vector3(20, 20, 20)]) {
        const o = v.occlusionAlong(at, dir);
        expect(o).toBeGreaterThanOrEqual(0);
        expect(o).toBeLessThanOrEqual(1);
      }
    }
  });
});
