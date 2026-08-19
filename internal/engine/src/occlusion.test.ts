import { describe, expect, it } from 'vitest';
import { OcclusionBuffer } from './occlusion.ts';

/**
 * 造一組裁剪空間的角。
 *
 * 這裡直接給「螢幕上的方形 + 距離」，不經過真的投影矩陣 —— 要驗的是緩衝的
 * 邏輯，不是矩陣乘法。x/y 用 −1..1 的 NDC，乘上 w 還原成裁剪空間。
 */
function corners(ndcMinX: number, ndcMaxX: number, ndcMinY: number, ndcMaxY: number, near: number, far = near): Float32Array {
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
