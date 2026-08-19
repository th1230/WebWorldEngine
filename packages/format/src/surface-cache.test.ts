import { describe, expect, it } from 'vitest';
import { bakeSurfaceCache } from './surface-cache.ts';

/** 一個佔滿 [-5,5]³ 其中一面的方形（兩個三角形），可以指定每個頂點的顏色。 */
function quad(z: number, color: [number, number, number]): {
  positions: number[];
  indices: number[];
  colors: number[];
} {
  const positions = [-5, -5, z, 5, -5, z, 5, 5, z, -5, 5, z];
  const indices = [0, 1, 2, 0, 2, 3];
  const colors: number[] = [];
  for (let i = 0; i < 4; i++) colors.push(color[0], color[1], color[2]);
  return { positions, indices, colors };
}

/** 查一格的 RGB。 */
function cellAt(
  cache: ReturnType<typeof bakeSurfaceCache>,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const n = cache.resolution;
  const gx = Math.min(n - 1, Math.max(0, Math.floor(((x - cache.min[0]) / cache.size[0]) * n)));
  const gy = Math.min(n - 1, Math.max(0, Math.floor(((y - cache.min[1]) / cache.size[1]) * n)));
  const gz = Math.min(n - 1, Math.max(0, Math.floor(((z - cache.min[2]) / cache.size[2]) * n)));
  const i = ((gz * n + gy) * n + gx) * 3;
  return [cache.data[i]!, cache.data[i + 1]!, cache.data[i + 2]!];
}

describe('表面快取：追蹤打到的時候那是什麼顏色', () => {
  it('紅色的面查出來是紅的，不是白的', () => {
    // 這是整個東西存在的理由。距離場答得出「有東西擋著」，答不出「那是紅的」
    // —— 而沒有顏色就只有遮蔽，沒有反彈。
    const { positions, indices, colors } = quad(0, [1, 0, 0]);
    const cache = bakeSurfaceCache(positions, indices, colors, { resolution: 8 });
    const [r, g, b] = cellAt(cache, 0, 0, 0);
    expect(r).toBeGreaterThan(0.9);
    expect(g).toBeLessThan(0.1);
    expect(b).toBeLessThan(0.1);
  });

  it('同一格裡兩個不同顏色的三角形取平均，不是後面蓋掉前面', () => {
    // 蓋掉的話結果跟著三角形在陣列裡的順序走 —— 而那個順序沒有意義：同一份
    // 幾何重新匯出一次顏色就變了。
    // 兩個三角形**重疊在同一個位置** —— 稍微錯開是不行的：外框是貼著幾何
    // 算的，錯開 0.01 而整份場只有 0.01 深的話那就是整整一格。
    const positions = [
      -1, -1, 0, 1, -1, 0, 0, 1, 0,
      -1, -1, 0, 1, -1, 0, 0, 1, 0,
    ];
    const colors = [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1];
    const cache = bakeSurfaceCache(positions, null, colors, { resolution: 4 });
    // 查三角形的重心 —— 顏色刷進去的就是那一格。
    const [r, g, b] = cellAt(cache, 0, -1 / 3, 0);
    expect(r).toBeCloseTo(0.5, 1);
    expect(b).toBeCloseTo(0.5, 1);
    expect(g).toBeCloseTo(0, 5);
  });

  it('沒有頂點顏色的時候用 flat 給的那一個', () => {
    const { positions, indices } = quad(0, [0, 0, 0]);
    const cache = bakeSurfaceCache(positions, indices, null, { resolution: 8, flat: [0.2, 0.8, 0.4] });
    const [r, g, b] = cellAt(cache, 0, 0, 0);
    expect(r).toBeCloseTo(0.2, 5);
    expect(g).toBeCloseTo(0.8, 5);
    expect(b).toBeCloseTo(0.4, 5);
  });

  it('旁邊一格也查得到顏色 —— 追蹤是停在表面**附近**，不是表面上', () => {
    // 這一條是擴散那一步的理由。差一格就查到空的，而空的是黑的 —— 症狀是
    // 反彈光比實際暗一大截，而且會隨追蹤的步長忽明忽暗。
    const { positions, indices, colors } = quad(0, [1, 0, 0]);
    const cache = bakeSurfaceCache(positions, indices, colors, { resolution: 8, padding: 0.5 });
    const cell = cache.size[2] / cache.resolution;
    const [r] = cellAt(cache, 0, 0, cell * 1.2);
    expect(r).toBeGreaterThan(0.5);
  });

  it('離得夠遠的地方還是黑的 —— 擴散只有一層，不是把整份塗滿', () => {
    // 塗滿的話任何方向的追蹤都會拿到顏色，等於沒有幾何資訊了。
    const { positions, indices, colors } = quad(0, [1, 0, 0]);
    const cache = bakeSurfaceCache(positions, indices, colors, { resolution: 16, padding: 1 });
    const [r, g, b] = cellAt(cache, 0, 0, cache.size[2] * 0.45);
    expect(r + g + b).toBeCloseTo(0, 5);
  });

  it('外框與距離場同一個算法 —— 兩份場對不上的話追蹤會查到隔壁', () => {
    const { positions, indices, colors } = quad(0, [1, 1, 1]);
    const cache = bakeSurfaceCache(positions, indices, colors, { resolution: 8, padding: 0.25 });
    // 幾何是 10 寬，padding 0.25 → 外擴到 15，最小角在 -7.5。
    expect(cache.min[0]).toBeCloseTo(-7.5, 5);
    expect(cache.size[0]).toBeCloseTo(15, 5);
  });

  it('完全平的那一軸不會把整份場壓成零', () => {
    // z 全部是 0 的話 span 是 0 —— 除下去會變 NaN，而 NaN 查表回傳的是黑的。
    const { positions, indices, colors } = quad(0, [1, 0, 0]);
    const cache = bakeSurfaceCache(positions, indices, colors, { resolution: 8 });
    expect(Number.isFinite(cache.size[2])).toBe(true);
    expect(cache.size[2]).toBeGreaterThan(0);
    expect(cache.data.some((v) => Number.isNaN(v))).toBe(false);
  });
});
