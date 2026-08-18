import { describe, expect, it } from 'vitest';
import { buildTerrain } from './terrain.ts';

/**
 * 地表的失效方式全部是**看得見但不報錯**的：接縫裂開、邊緣缺一條、
 * 遠處太糊。所以測試驗的是幾何本身的性質，不是「有沒有跑完」。
 */

/** 有起伏、決定性、而且好算 —— 誤差可以手推。 */
const hills = (x: number, z: number): number => Math.sin(x * 0.05) * 10 + Math.cos(z * 0.05) * 6;

describe('高度場地表', () => {
  it('每一塊都是一條 LOD 鏈，誤差嚴格遞增', () => {
    const terrain = buildTerrain({ size: 400, tiles: 2, segments: 32, height: hills });

    expect(terrain.chains).toHaveLength(4);
    for (const [i, chain] of terrain.chains.entries()) {
      expect(chain.errors[0], `第 ${i} 塊`).toBe(0);
      for (let k = 1; k < chain.errors.length; k++) {
        // 「更粗 = 更不準」是選階與遠景合併都在假設的性質。
        expect(chain.errors[k]!, `第 ${i} 塊第 ${k} 階`).toBeGreaterThan(chain.errors[k - 1]!);
      }
      expect(chain.lods).toHaveLength(chain.errors.length);
    }
  });

  it('誤差是**精確的**，不是估的 —— 拿粗階曲面直接比', () => {
    // 這一條是整個品質契約的地基：選階比的就是這個數字。估小了就是靜靜
    // 違反契約（畫面比宣稱的糊），而不會有任何錯誤。
    const terrain = buildTerrain({ size: 200, tiles: 1, segments: 16, height: hills });
    const chain = terrain.chains[0]!;

    // 第 1 階是隔一個取一個，所以格心那一點的誤差就是「真值 - 兩端平均」。
    // 拿一個算得出來的點驗：地形沿 x 是正弦，中點的下垂量是可推的。
    const cell = 200 / 16;
    const worst = chain.errors[1]!;
    let manual = 0;
    for (let i = 1; i < 16; i += 2) {
      const x = -100 + i * cell;
      const mid = hills(x, -100);
      const avg = (hills(x - cell, -100) + hills(x + cell, -100)) / 2;
      manual = Math.max(manual, Math.abs(mid - avg));
    }
    // 量到的誤差不可能小於某一條線上算出來的（那只是所有頂點裡的一部分）。
    expect(worst).toBeGreaterThanOrEqual(manual - 1e-6);
  });

  it('裙邊深度是算出來的，而且蓋得住最粗那階的裂縫', () => {
    // 猜一個「看起來夠深」的數字在別的地形上就是錯的。裂縫的高度差最多是
    // 兩塊各自的誤差相加，所以最粗那階的兩倍一定夠。
    const terrain = buildTerrain({ size: 400, tiles: 2, segments: 32, height: hills });
    const coarsest = Math.max(...terrain.chains.map((c) => c.errors[c.errors.length - 1]!));

    expect(terrain.skirtDepth).toBeGreaterThan(0);
    expect(terrain.skirtDepth).toBeGreaterThanOrEqual(coarsest * 2 - 1e-6);
  });

  it('每一階都真的有裙邊 —— 最低的頂點要低於地表最低點', () => {
    // 裙邊沒生效的症狀是「相鄰兩塊之間有一條看得到背景的縫」，而那只在
    // 兩塊剛好挑到不同階時出現 —— 很容易在測試裡漏掉。
    const terrain = buildTerrain({ size: 400, tiles: 2, segments: 32, height: hills });

    for (const [i, chain] of terrain.chains.entries()) {
      for (const [k, geometry] of chain.lods.entries()) {
        const y = geometry.getAttribute('position').array as Float32Array;
        let lowest = Infinity;
        let lowestSurface = Infinity;
        // 表面頂點在前面（side²），裙邊在後面（四條邊各兩排，8×side）。
        // 所以 N = side² + 8·side → side = √(16 + N) − 4。
        const n = y.length / 3;
        const side = Math.sqrt(16 + n) - 4;
        expect(Number.isInteger(side), '頂點數對不上預期的排法').toBe(true);
        const surfaceCount = side * side;
        for (let v = 0; v < y.length / 3; v++) {
          const h = y[v * 3 + 1]!;
          if (h < lowest) lowest = h;
          if (v < surfaceCount && h < lowestSurface) lowestSurface = h;
        }
        expect(lowest, `第 ${i} 塊第 ${k} 階`).toBeLessThan(lowestSurface);
      }
    }
  });

  it('塊的頂點是相對中心的 —— 世界很大時絕對座標會塌', () => {
    // 頂點是 Float32Array。在原點外十萬單位處直接烘絕對座標，頂點會開始
    // 互相塌陷，而症狀是「遠方的地表看起來髒髒的」。
    const terrain = buildTerrain({ size: 400, tiles: 2, segments: 8, height: hills });
    const [cx, cz] = terrain.centers[0]!;
    expect(Math.abs(cx)).toBeGreaterThan(0);

    const p = terrain.chains[0]!.lods[0]!.getAttribute('position');
    for (let v = 0; v < p.count; v++) {
      // 相對座標的範圍只有半塊，不是整片地表。
      expect(Math.abs(p.getX(v))).toBeLessThanOrEqual(400 / 2 / 2 + 1e-3);
      expect(Math.abs(p.getZ(v))).toBeLessThanOrEqual(400 / 2 / 2 + 1e-3);
    }
    void cz;
  });

  it('segments 不是 2 的冪就當場丟', () => {
    // 除不盡的話最後一排格子會被默默丟掉 —— 地表邊緣缺一條，不報錯。
    expect(() => buildTerrain({ size: 100, tiles: 1, segments: 12, height: hills })).toThrow(/2 的冪/);
  });

  it('切幾塊都是同一片地形 —— 高度用世界座標算', () => {
    // 用區域座標算的話，每一塊都會拿到同一段地形複製貼上，而那看起來
    // 像「地形有重複的圖樣」，不像 bug。
    const one = buildTerrain({ size: 400, tiles: 1, segments: 32, height: hills });
    const four = buildTerrain({ size: 400, tiles: 2, segments: 16, height: hills });

    // 兩種切法在同一個世界位置上的高度必須一致。
    const at = (t: ReturnType<typeof buildTerrain>, wx: number, wz: number): number => {
      let best = Infinity;
      let found = 0;
      t.chains.forEach((chain, i) => {
        const [cx, cz] = t.centers[i]!;
        const p = chain.lods[0]!.getAttribute('position');
        for (let v = 0; v < p.count; v++) {
          const d = Math.hypot(cx + p.getX(v) - wx, cz + p.getZ(v) - wz);
          if (d < best) {
            best = d;
            found = p.getY(v);
          }
        }
      });
      return found;
    };

    expect(at(four, 50, 50)).toBeCloseTo(at(one, 50, 50), 5);
  });
});
