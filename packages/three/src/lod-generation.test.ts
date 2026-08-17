import { IcosahedronGeometry, SphereGeometry, TorusKnotGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { generateLodLevels, type GeometryData } from './lod-generation.ts';

/**
 * 這些測試跑的是**真的 meshoptimizer WASM**，不是 mock。簡化的品質沒辦法
 * 靠 mock 驗 —— 而「產生成功但每一階都跟原本一樣」正是最容易發生、也最難
 * 察覺的失效。
 */

function toData(geometry: {
  getAttribute(name: string): { array: ArrayLike<number>; itemSize: number };
  getIndex(): { array: ArrayLike<number> } | null;
}): GeometryData {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  return {
    attributes: {
      position: { array: Float32Array.from(position.array), itemSize: position.itemSize },
    },
    indices: index === null ? null : Uint32Array.from(index.array),
  };
}

const triangles = (indices: Uint32Array): number => indices.length / 3;

describe('generateLodLevels', () => {
  it('索引幾何：每一階都比上一階少', async () => {
    const source = toData(new SphereGeometry(1, 48, 32));
    const before = triangles(source.indices!);

    const levels = await generateLodLevels(source);

    expect(levels.length).toBeGreaterThan(0);
    let previous = before;
    for (const level of levels) {
      const now = triangles(level.indices);
      expect(now).toBeLessThan(previous);
      previous = now;
    }
  });

  it('誤差是世界單位，而且嚴格遞增', async () => {
    // 「更粗 = 更不準」是所有下游都在假設的性質。簡化器不保證它
    // （每個目標各做一次貪婪選擇），所以被支配的階會被丟掉。
    const levels = await generateLodLevels(toData(new SphereGeometry(1, 48, 32)));

    expect(levels[0]!.error).toBeGreaterThan(0);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]!.error).toBeGreaterThan(levels[i - 1]!.error);
    }
    // 半徑 1 的球，誤差不該是半個球那麼大
    expect(levels.at(-1)!.error).toBeLessThan(0.5);
  });

  it('同時比較粗又比較不準的階會被丟掉', async () => {
    // 這個組合實測會產生一個被支配的階（球體第 5 階 0.3888 / 80 個三角形，
    // 第 6 階 0.3709 / 32 個）。留著它只是佔記憶體。
    const levels = await generateLodLevels(toData(new SphereGeometry(1, 48, 32)));

    for (let i = 1; i < levels.length; i++) {
      const finer = levels[i - 1]!;
      const coarser = levels[i]!;
      expect(coarser.indices.length).toBeLessThan(finer.indices.length);
      expect(coarser.error).toBeGreaterThan(finer.error);
    }
  });

  it('半徑放大 10 倍，誤差也放大 10 倍', async () => {
    // 誤差若回報的是相對值，螢幕投影就算不出來 —— 而那個錯誤的症狀是
    // 大物件永遠選最細、小物件永遠選最粗，畫面「只是有點怪」。
    const small = await generateLodLevels(toData(new SphereGeometry(1, 48, 32)));
    const large = await generateLodLevels(toData(new SphereGeometry(10, 48, 32)));

    expect(large[0]!.error).toBeCloseTo(small[0]!.error * 10, 3);
  });

  it('**非索引幾何也要能簡化** —— 沒熔接的話會靜靜地失敗', async () => {
    // IcosahedronGeometry 是非索引的：每個三角形自己三個頂點，一條共用邊
    // 都沒有。不先熔接的話簡化器會原樣回傳，而呼叫端會拿到一條「產生成功」
    // 但每一階都一樣的鏈。
    const source = toData(new IcosahedronGeometry(1, 4));
    expect(source.indices).toBeNull();

    const levels = await generateLodLevels(source);

    expect(levels.length).toBeGreaterThan(0);
    expect(triangles(levels[0]!.indices)).toBeLessThan(500);
  });

  it('所有 attribute 一起帶過去，而且長度對得上', async () => {
    // 只搬 position 的話，材質會拿到對不上的法線與 UV —— 畫面壞掉但不報錯。
    const geometry = new SphereGeometry(1, 48, 32);
    const source: GeometryData = {
      attributes: {
        position: {
          array: Float32Array.from(geometry.getAttribute('position').array),
          itemSize: 3,
        },
        normal: {
          array: Float32Array.from(geometry.getAttribute('normal').array),
          itemSize: 3,
        },
        uv: { array: Float32Array.from(geometry.getAttribute('uv').array), itemSize: 2 },
      },
      indices: Uint32Array.from(geometry.getIndex()!.array),
    };

    const levels = await generateLodLevels(source);

    for (const level of levels) {
      const vertices = level.attributes['position']!.array.length / 3;
      expect(level.attributes['normal']!.array.length / 3).toBe(vertices);
      expect(level.attributes['uv']!.array.length / 2).toBe(vertices);
      // 索引必須指向壓縮後的頂點範圍，不是原本的編號
      for (const index of level.indices) expect(index).toBeLessThan(vertices);
    }
  });

  it('壓縮之後頂點確實變少，不是每階都存一整份', async () => {
    const geometry = new TorusKnotGeometry(1, 0.3, 128, 32);
    const source = toData(geometry);
    const originalVertices = source.attributes['position']!.array.length / 3;

    const levels = await generateLodLevels(source);

    expect(levels[0]!.attributes['position']!.array.length / 3).toBeLessThan(originalVertices);
  });

  it('三角形太少就不產生，而不是回傳一堆一模一樣的階', async () => {
    const source: GeometryData = {
      attributes: { position: { array: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), itemSize: 3 } },
      indices: new Uint32Array([0, 1, 2]),
    };

    const levels = await generateLodLevels(source);
    expect(levels).toEqual([]);
  });

  it('沒有 position 就丟例外，而不是產生空的鏈', async () => {
    const source: GeometryData = {
      attributes: { uv: { array: new Float32Array([0, 0]), itemSize: 2 } },
      indices: new Uint32Array([0, 0, 0]),
    };

    await expect(generateLodLevels(source)).rejects.toThrow(/position/);
  });

  it('ratios 決定階數', async () => {
    const source = toData(new SphereGeometry(1, 48, 32));
    const levels = await generateLodLevels(source, { ratios: [0.5] });
    expect(levels.length).toBe(1);
  });
});
