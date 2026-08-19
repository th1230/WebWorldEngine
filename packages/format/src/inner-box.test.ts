import { describe, expect, it } from 'vitest';
import { innerBox } from './inner-box.ts';

/** 一個軸對齊的方盒，中心在原點。 */
function box(half: number): { positions: Float32Array; indices: Uint32Array } {
  const h = half;
  const positions = new Float32Array([
    -h, -h, -h, h, -h, -h, -h, h, -h, h, h, -h,
    -h, -h, h, h, -h, h, -h, h, h, h, h, h,
  ]);
  const indices = new Uint32Array([
    0, 2, 3, 0, 3, 1, // -z
    4, 5, 7, 4, 7, 6, // +z
    0, 1, 5, 0, 5, 4, // -y
    2, 6, 7, 2, 7, 3, // +y
    0, 4, 6, 0, 6, 2, // -x
    1, 3, 7, 1, 7, 5, // +x
  ]);
  return { positions, indices };
}

/** 一顆球，用經緯度切。 */
function sphere(radius: number, segments = 16): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let iy = 0; iy <= segments; iy++) {
    const v = (iy / segments) * Math.PI;
    for (let ix = 0; ix <= segments; ix++) {
      const u = (ix / segments) * Math.PI * 2;
      positions.push(
        radius * Math.sin(v) * Math.cos(u),
        radius * Math.cos(v),
        radius * Math.sin(v) * Math.sin(u),
      );
    }
  }
  const row = segments + 1;
  for (let iy = 0; iy < segments; iy++) {
    for (let ix = 0; ix < segments; ix++) {
      const a = iy * row + ix;
      indices.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

describe('內接盒', () => {
  it('方盒的內接盒在裡面，而且佔掉大部分', () => {
    const { positions, indices } = box(10);
    const result = innerBox(positions, indices, { resolution: 24 })!;
    expect(result).not.toBeNull();

    // 一定在裡面。
    expect(result.minX).toBeGreaterThan(-10);
    expect(result.maxX).toBeLessThan(10);
    expect(result.minY).toBeGreaterThan(-10);
    expect(result.maxY).toBeLessThan(10);

    // 而且不能小得沒有用 —— 方盒的內接盒應該接近本體。
    expect(result.maxX - result.minX).toBeGreaterThan(14);
  });

  it('球的內接盒整個在球面裡 —— 八個角都要', () => {
    // 這一條擋的是「拿外接盒充數」：外接盒的角在球外面。
    const radius = 10;
    const { positions, indices } = sphere(radius, 24);
    const result = innerBox(positions, indices, { resolution: 24 })!;
    expect(result).not.toBeNull();

    for (const x of [result.minX, result.maxX]) {
      for (const y of [result.minY, result.maxY]) {
        for (const z of [result.minZ, result.maxZ]) {
          expect(Math.sqrt(x * x + y * y + z * z)).toBeLessThan(radius);
        }
      }
    }
  });

  it('球的內接盒不會小到沒有用', () => {
    // 只驗「在裡面」的話，回傳一個微小的盒子也會過 —— 而那等於沒有遮蔽物。
    const radius = 10;
    const { positions, indices } = sphere(radius, 24);
    const result = innerBox(positions, indices, { resolution: 24 })!;
    const side = result.maxX - result.minX;
    // 球的最大內接正方體邊長是 2r/√3 ≈ 11.5。體素化加上縮一格會小一些，
    // 但不該小於一半。
    expect(side).toBeGreaterThan(5);
  });

  it('margin 會讓盒子更小，不會更大', () => {
    const { positions, indices } = box(10);
    const tight = innerBox(positions, indices, { resolution: 24 })!;
    const loose = innerBox(positions, indices, { resolution: 24, margin: 2 })!;
    expect(loose.minX).toBeGreaterThan(tight.minX);
    expect(loose.maxX).toBeLessThan(tight.maxX);
  });

  it('破面的模型回 null，不回一個錯的盒子', () => {
    // 灌水會從破洞漏進去，於是內部被標成外面。這是刻意的失敗方向：
    // 沒有遮蔽物只是少剔一點，而一個錯的遮蔽物會讓東西消失。
    const { positions, indices } = box(10);
    // 拿掉一整面（前兩個三角形）。
    const holed = indices.slice(6);
    expect(innerBox(positions, holed, { resolution: 16 })).toBeNull();
  });

  it('平面沒有內部，回 null', () => {
    const positions = new Float32Array([-1, 0, -1, 1, 0, -1, -1, 0, 1, 1, 0, 1]);
    const indices = new Uint32Array([0, 1, 2, 1, 3, 2]);
    expect(innerBox(positions, indices, { resolution: 16 })).toBeNull();
  });

  it('三角形太少直接回 null', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(innerBox(positions, new Uint32Array([0, 1, 2]))).toBeNull();
  });

  it('沒有索引的幾何也能算', () => {
    const { positions, indices } = box(10);
    const flat = new Float32Array(indices.length * 3);
    for (let i = 0; i < indices.length; i++) {
      flat[i * 3] = positions[indices[i]! * 3]!;
      flat[i * 3 + 1] = positions[indices[i]! * 3 + 1]!;
      flat[i * 3 + 2] = positions[indices[i]! * 3 + 2]!;
    }
    const result = innerBox(flat, null, { resolution: 24 });
    expect(result).not.toBeNull();
    expect(result!.maxX - result!.minX).toBeGreaterThan(14);
  });
});
