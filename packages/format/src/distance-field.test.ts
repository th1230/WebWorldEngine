import { describe, expect, it } from 'vitest';
import { bakeDistanceField } from './distance-field.ts';

/** 一個以原點為中心、邊長 2h 的方盒。 */
function box(h: number): { positions: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array([
    -h,
    -h,
    -h,
    h,
    -h,
    -h,
    -h,
    h,
    -h,
    h,
    h,
    -h,
    -h,
    -h,
    h,
    h,
    -h,
    h,
    -h,
    h,
    h,
    h,
    h,
    h,
  ]);
  const indices = new Uint32Array([
    0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3,
    7, 1, 7, 5,
  ]);
  return { positions, indices };
}

/** 查一個世界座標的距離（最近的格子，不內插）。 */
function sample(
  field: ReturnType<typeof bakeDistanceField>,
  x: number,
  y: number,
  z: number,
): number {
  const n = field.resolution;
  const gx = Math.min(n - 1, Math.max(0, Math.floor(((x - field.min[0]) / field.size[0]) * n)));
  const gy = Math.min(n - 1, Math.max(0, Math.floor(((y - field.min[1]) / field.size[1]) * n)));
  const gz = Math.min(n - 1, Math.max(0, Math.floor(((z - field.min[2]) / field.size[2]) * n)));
  return field.data[(gz * n + gy) * n + gx]!;
}

describe('距離場', () => {
  it('盒子外面是正的、裡面是負的、表面附近接近 0', () => {
    const { positions, indices } = box(10);
    const field = bakeDistanceField(positions, indices, { resolution: 32 });

    // 正中心在裡面。
    expect(sample(field, 0, 0, 0)).toBeLessThan(0);
    // 遠遠在外面。
    expect(sample(field, 14, 14, 14)).toBeGreaterThan(0);
    // 貼著表面 —— 一格的尺度以內。
    const cell = field.size[0] / field.resolution;
    expect(Math.abs(sample(field, 10, 0, 0))).toBeLessThan(cell * 2);
  });

  it('離得越遠距離越大 —— 這是「可以安全走多遠」的意思', () => {
    // 距離場的價值全部來自這個單調性：光線靠它決定一步跨多遠。不單調的話
    // 光線會跨過表面，而症狀是**遮蔽時有時無**。
    const { positions, indices } = box(6);
    const field = bakeDistanceField(positions, indices, { resolution: 32, padding: 1 });

    let previous = -Infinity;
    for (const x of [7, 8, 9, 10, 11]) {
      const d = sample(field, x, 0, 0);
      expect(d).toBeGreaterThanOrEqual(previous);
      previous = d;
    }
  });

  it('場比物體大一圈 —— 貼著表面往外走不會立刻出界', () => {
    const { positions, indices } = box(10);
    const field = bakeDistanceField(positions, indices, { resolution: 16, padding: 0.25 });
    expect(field.min[0]).toBeLessThan(-10);
    expect(field.min[0] + field.size[0]).toBeGreaterThan(10);
  });

  it('沒有 Infinity —— 那個上不了貼圖', () => {
    const { positions, indices } = box(10);
    const field = bakeDistanceField(positions, indices, { resolution: 16 });
    for (const v of field.data) expect(Number.isFinite(v)).toBe(true);
  });

  it('破面的模型退化成無號，但還是擋得住光', () => {
    // 灌水會從破洞漏進去，於是沒有「裡面」。那是安全的失敗方向：場還在，
    // 光線照樣走不過去，只是貼著表面時少了一點準度。
    const { positions, indices } = box(10);
    const holed = indices.slice(6);
    const field = bakeDistanceField(positions, holed, { resolution: 16 });
    // 表面附近仍然接近 0（擋得住），只是中心不再是負的。
    const cell = field.size[0] / field.resolution;
    expect(Math.abs(sample(field, 10, 0, 0))).toBeLessThan(cell * 2);
    expect(field.data.some((v) => v < 0)).toBe(false);
  });

  it('沒有索引的幾何也能烘', () => {
    const { positions, indices } = box(8);
    const flat = new Float32Array(indices.length * 3);
    for (let i = 0; i < indices.length; i++) {
      flat[i * 3] = positions[indices[i]! * 3]!;
      flat[i * 3 + 1] = positions[indices[i]! * 3 + 1]!;
      flat[i * 3 + 2] = positions[indices[i]! * 3 + 2]!;
    }
    const field = bakeDistanceField(flat, null, { resolution: 16 });
    expect(sample(field, 0, 0, 0)).toBeLessThan(0);
  });
});
