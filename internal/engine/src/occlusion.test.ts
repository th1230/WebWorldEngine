import { describe, expect, it } from 'vitest';
import { OcclusionBuffer } from './occlusion.ts';

/**
 * 造一組裁剪空間的角。
 *
 * 這裡直接給「螢幕上的方形 + 距離」，不經過真的投影矩陣 —— 要驗的是緩衝的
 * 邏輯，不是矩陣乘法。x/y 用 −1..1 的 NDC，乘上 w 還原成裁剪空間。
 */
function corners(
  ndcMinX: number,
  ndcMaxX: number,
  ndcMinY: number,
  ndcMaxY: number,
  near: number,
  far = near,
): Float32Array {
  const out = new Float32Array(32);
  let i = 0;
  for (const w of [near, far]) {
    for (const y of [ndcMinY, ndcMaxY]) {
      for (const x of [ndcMinX, ndcMaxX]) {
        out[i++] = x * w;
        out[i++] = y * w;
        out[i++] = 0;
        out[i++] = w;
      }
    }
  }
  return out;
}

describe('遮蔽緩衝', () => {
  it('沒有遮蔽物的時候什麼都不剔', () => {
    const buffer = new OcclusionBuffer(64, 64);
    buffer.finish();
    expect(buffer.isOccluded(corners(-0.1, 0.1, -0.1, 0.1, 100))).toBe(false);
  });

  it('近的大東西擋住後面同一個位置的小東西', () => {
    const buffer = new OcclusionBuffer(64, 64);
    // 遮蔽物：畫面正中一大塊，距離 10。
    buffer.addOccluder(corners(-0.8, 0.8, -0.8, 0.8, 10));
    buffer.finish();
    // 被測物：同一個位置的小東西，距離 100。
    expect(buffer.isOccluded(corners(-0.1, 0.1, -0.1, 0.1, 100))).toBe(true);
  });

  it('在遮蔽物前面的東西不會被剔', () => {
    // 這是最不能錯的方向：剔掉看得見的東西 = 東西不見了。
    const buffer = new OcclusionBuffer(64, 64);
    buffer.addOccluder(corners(-0.8, 0.8, -0.8, 0.8, 100));
    buffer.finish();
    expect(buffer.isOccluded(corners(-0.1, 0.1, -0.1, 0.1, 10))).toBe(false);
  });

  it('只有一部分被擋住的不會被剔', () => {
    // 遮蔽物只蓋住左半邊，被測物橫跨中線 —— 右半邊看得見。
    const buffer = new OcclusionBuffer(64, 64);
    buffer.addOccluder(corners(-0.9, -0.1, -0.9, 0.9, 10));
    buffer.finish();
    expect(buffer.isOccluded(corners(-0.3, 0.5, -0.2, 0.2, 100))).toBe(false);
  });

  it('跨過近平面的東西不剔，也不能當遮蔽物', () => {
    const buffer = new OcclusionBuffer(64, 64);
    // w = 0 的角代表在相機平面上。
    const straddling = corners(-0.5, 0.5, -0.5, 0.5, 0);
    expect(buffer.addOccluder(straddling)).toBe(false);
    buffer.addOccluder(corners(-0.9, 0.9, -0.9, 0.9, 10));
    buffer.finish();
    expect(buffer.isOccluded(straddling)).toBe(false);
  });

  it('超出畫面邊界的不剔 —— 畫面外沒有遮蔽物資料', () => {
    const buffer = new OcclusionBuffer(64, 64);
    buffer.addOccluder(corners(-1, 1, -1, 1, 10));
    buffer.finish();
    // 貼著邊緣，擴一個像素之後就出界了。
    expect(buffer.isOccluded(corners(-1, -0.9, -0.2, 0.2, 100))).toBe(false);
  });

  it('清掉之後不再擋住任何東西', () => {
    const buffer = new OcclusionBuffer(64, 64);
    buffer.addOccluder(corners(-0.8, 0.8, -0.8, 0.8, 10));
    buffer.finish();
    expect(buffer.isOccluded(corners(-0.1, 0.1, -0.1, 0.1, 100))).toBe(true);
    buffer.clear();
    buffer.finish();
    expect(buffer.isOccluded(corners(-0.1, 0.1, -0.1, 0.1, 100))).toBe(false);
  });

  it('兩個各擋一半的遮蔽物合起來擋得住', () => {
    // 這一條驗的是「門檻取 min」那件事：合起來要比各自都強。
    const buffer = new OcclusionBuffer(64, 64);
    buffer.addOccluder(corners(-0.9, 0.05, -0.9, 0.9, 10));
    buffer.addOccluder(corners(-0.05, 0.9, -0.9, 0.9, 10));
    buffer.finish();
    expect(buffer.isOccluded(corners(-0.5, 0.5, -0.3, 0.3, 100))).toBe(true);
  });

  it('遠的遮蔽物擋不住更遠一點點但在它前面的東西', () => {
    const buffer = new OcclusionBuffer(64, 64);
    // 遮蔽物本體從 50 延伸到 80，門檻取最遠的 80。
    buffer.addOccluder(corners(-0.8, 0.8, -0.8, 0.8, 50, 80));
    buffer.finish();
    // 70 在遮蔽物的深度範圍裡 —— 可能在它前面，不能剔。
    expect(buffer.isOccluded(corners(-0.1, 0.1, -0.1, 0.1, 70))).toBe(false);
    // 100 確定在後面。
    expect(buffer.isOccluded(corners(-0.1, 0.1, -0.1, 0.1, 100))).toBe(true);
  });

  it('統計數字對得上', () => {
    const buffer = new OcclusionBuffer(64, 64);
    buffer.addOccluder(corners(-0.8, 0.8, -0.8, 0.8, 10));
    buffer.finish();
    buffer.isOccluded(corners(-0.1, 0.1, -0.1, 0.1, 100));
    buffer.isOccluded(corners(-0.1, 0.1, -0.1, 0.1, 1));
    expect(buffer.occludersDrawn).toBe(1);
    expect(buffer.tested).toBe(2);
    expect(buffer.culled).toBe(1);
  });
});

describe('保守性：亂數跑一萬組，絕不剔掉看得見的東西', () => {
  /** 可重現的亂數 —— 失敗時要能重跑同一組。 */
  function makeRandom(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  it('比所有遮蔽物都近的東西，一次都沒有被剔掉', () => {
    // 這是整個模組唯一不能錯的方向。單元測試舉的是幾個手挑的例子，而手挑的
    // 例子只會涵蓋想得到的情況 —— 想不到的那些正是會出事的。
    const random = makeRandom(12345);
    let culledInFront = 0;

    for (let trial = 0; trial < 10000; trial++) {
      const buffer = new OcclusionBuffer(64, 64);
      const occluderCount = 1 + ((random() * 4) | 0);
      let nearestOccluder = Infinity;

      for (let i = 0; i < occluderCount; i++) {
        const cx = random() * 2 - 1;
        const cy = random() * 2 - 1;
        const half = 0.05 + random() * 0.8;
        const near = 5 + random() * 100;
        const far = near + random() * 50;
        nearestOccluder = Math.min(nearestOccluder, near);
        buffer.addOccluder(corners(cx - half, cx + half, cy - half, cy + half, near, far));
      }
      buffer.finish();

      // 被測物**整個在最近的遮蔽物前面**，所以它一定看得見。
      const tx = random() * 2 - 1;
      const ty = random() * 2 - 1;
      const thalf = 0.02 + random() * 0.4;
      const tw = nearestOccluder * (0.05 + random() * 0.9);
      if (buffer.isOccluded(corners(tx - thalf, tx + thalf, ty - thalf, ty + thalf, tw, tw))) {
        culledInFront++;
      }
    }

    expect(culledInFront).toBe(0);
    // 這一條自己**證明不了模組有用** —— 一個永遠回 false 的實作也會過。
    // 「它真的會剔東西」是下面那一條的事，兩條要一起看。
  });

  it('在後面的東西確實會被剔掉一些 —— 否則上一條只證明了它什麼都不做', () => {
    const random = makeRandom(999);
    let culled = 0;
    for (let trial = 0; trial < 2000; trial++) {
      const buffer = new OcclusionBuffer(64, 64);
      buffer.addOccluder(corners(-0.9, 0.9, -0.9, 0.9, 10, 12));
      buffer.finish();
      const cx = (random() - 0.5) * 0.6;
      const cy = (random() - 0.5) * 0.6;
      const half = 0.02 + random() * 0.1;
      if (buffer.isOccluded(corners(cx - half, cx + half, cy - half, cy + half, 100))) culled++;
    }
    expect(culled).toBeGreaterThan(1500);
  });
});

describe('球體測試（真的用一個透視矩陣）', () => {
  const WIDTH = 128;
  const HEIGHT = 128;
  const FOV = Math.PI / 3;

  /**
   * 相機在原點看向 −z 的透視投影，column-major。
   *
   * 用真的矩陣而不是手算的裁剪座標 —— 球體那條路裡有一次矩陣乘法與一個
   * 螢幕半徑的式子，那兩個只有在真的投影下才驗得到。
   */
  function perspective(): { matrix: Float64Array; radiusScale: number } {
    const f = 1 / Math.tan(FOV / 2);
    const near = 0.1;
    const far = 1000;
    const matrix = new Float64Array(16);
    matrix[0] = f;
    matrix[5] = f;
    matrix[10] = (far + near) / (near - far);
    matrix[11] = -1;
    matrix[14] = (2 * far * near) / (near - far);
    // w = −z，所以看向 −z 的東西 w 是正的。
    return { matrix, radiusScale: f * 0.5 * HEIGHT };
  }

  /** 把一個世界空間的軸對齊盒子轉成裁剪空間的 8 個角。 */
  function boxCorners(
    matrix: Float64Array,
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    minZ: number,
    maxZ: number,
  ): Float32Array {
    const out = new Float32Array(32);
    let i = 0;
    for (const z of [minZ, maxZ]) {
      for (const y of [minY, maxY]) {
        for (const x of [minX, maxX]) {
          out[i++] = matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!;
          out[i++] = matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!;
          out[i++] = matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!;
          out[i++] = matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!;
        }
      }
    }
    return out;
  }

  it('大牆後面的球被剔掉，前面的不被剔', () => {
    const { matrix, radiusScale } = perspective();
    const buffer = new OcclusionBuffer(WIDTH, HEIGHT);
    buffer.setViewProjection(matrix, radiusScale);
    // 一面在 z = −20 的大牆。
    buffer.addOccluder(boxCorners(matrix, -30, 30, -30, 30, -21, -20));
    buffer.finish();

    expect(buffer.isSphereOccluded(0, 0, -100, 2)).toBe(true);
    expect(buffer.isSphereOccluded(0, 0, -10, 2)).toBe(false);
  });

  it('球心在牆後面但球體穿過牆的不剔', () => {
    // 這是最容易寫錯的一個：只看球心的話會把它剔掉，而它其實有一半露在前面。
    const { matrix, radiusScale } = perspective();
    const buffer = new OcclusionBuffer(WIDTH, HEIGHT);
    buffer.setViewProjection(matrix, radiusScale);
    buffer.addOccluder(boxCorners(matrix, -30, 30, -30, 30, -21, -20));
    buffer.finish();
    // 球心在 z = −22（牆後），半徑 5 —— 最近點到 −17，在牆前面。
    expect(buffer.isSphereOccluded(0, 0, -22, 5)).toBe(false);
  });

  it('牆旁邊沒被蓋到的球不剔', () => {
    const { matrix, radiusScale } = perspective();
    const buffer = new OcclusionBuffer(WIDTH, HEIGHT);
    buffer.setViewProjection(matrix, radiusScale);
    // 牆只蓋住左半邊。
    buffer.addOccluder(boxCorners(matrix, -30, 0, -30, 30, -21, -20));
    buffer.finish();
    expect(buffer.isSphereOccluded(20, 0, -100, 2)).toBe(false);
  });

  it('亂數一萬組：在遮蔽物前面的球一次都沒被剔', () => {
    const { matrix, radiusScale } = perspective();
    let s = 4242;
    const random = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };

    let culledInFront = 0;
    let culledBehind = 0;
    for (let trial = 0; trial < 10000; trial++) {
      const buffer = new OcclusionBuffer(WIDTH, HEIGHT);
      buffer.setViewProjection(matrix, radiusScale);
      const wallZ = -(10 + random() * 60);
      const halfX = 2 + random() * 40;
      const halfY = 2 + random() * 40;
      buffer.addOccluder(boxCorners(matrix, -halfX, halfX, -halfY, halfY, wallZ - 1, wallZ));
      buffer.finish();

      const x = (random() - 0.5) * 40;
      const y = (random() - 0.5) * 40;
      const r = 0.2 + random() * 3;
      // 整顆球都在牆前面：球心 z 比 wallZ 大（比較靠近相機），而且最遠點也是。
      const frontZ = wallZ + 1 + r + random() * 5;
      if (buffer.isSphereOccluded(x, y, frontZ, r)) culledInFront++;
      // 整顆球都在牆後面。
      const behindZ = wallZ - 1 - r - random() * 50;
      if (buffer.isSphereOccluded(x, y, behindZ, r)) culledBehind++;
    }

    expect(culledInFront).toBe(0);
    // 而且要真的有剔到東西 —— 否則上面那條只證明了它什麼都不做。
    expect(culledBehind).toBeGreaterThan(2000);
  });
});
