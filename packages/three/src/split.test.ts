import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, PlaneGeometry, TorusKnotGeometry } from 'three';
import { splitGeometry, splitWithLods } from './split.ts';
import { MultiMesh } from './multi-mesh.ts';
import { MeshStandardMaterial } from 'three';

const triangles = (geometry: BufferGeometry): number => (geometry.getIndex()?.count ?? 0) / 3;

describe('切塊（Three 這一側）', () => {
  it('三角形總數不變 —— 少了就是破洞', () => {
    const source = new PlaneGeometry(100, 100, 60, 60);
    const pieces = splitGeometry(source, { chunks: 16, minTriangles: 16 });
    const total = pieces.reduce((sum, piece) => sum + triangles(piece), 0);
    expect(total).toBe(triangles(source));
    expect(pieces.length).toBeGreaterThan(1);
  });

  it('每一個屬性都跟著搬 —— 只搬 position 的話貼圖與打光會錯開', () => {
    const source = new PlaneGeometry(100, 100, 40, 40);
    const pieces = splitGeometry(source, { chunks: 9, minTriangles: 16 });

    for (const piece of pieces) {
      for (const name of Object.keys(source.attributes)) {
        const attribute = piece.getAttribute(name);
        expect(attribute).toBeDefined();
        expect(attribute.itemSize).toBe(source.getAttribute(name).itemSize);
        // 每個屬性的頂點數都要與 position 一致，否則 GPU 會讀到別人的資料。
        expect(attribute.count).toBe(piece.getAttribute('position').count);
      }
    }
  });

  it('UV 真的對得上，不是只有數量對', () => {
    // 數量對但內容錯是最典型的搬運 bug，而它不會報錯 —— 只會讓貼圖歪掉。
    // 這裡靠「同一個位置的頂點必須有同一個 UV」來抓。
    const source = new PlaneGeometry(100, 100, 20, 20);
    const sourcePosition = source.getAttribute('position');
    const sourceUv = source.getAttribute('uv');
    const uvAt = new Map<string, string>();
    for (let i = 0; i < sourcePosition.count; i++) {
      uvAt.set(
        `${sourcePosition.getX(i)},${sourcePosition.getY(i)},${sourcePosition.getZ(i)}`,
        `${sourceUv.getX(i)},${sourceUv.getY(i)}`,
      );
    }

    for (const piece of splitGeometry(source, { chunks: 9, minTriangles: 8 })) {
      const position = piece.getAttribute('position');
      const uv = piece.getAttribute('uv');
      for (let i = 0; i < position.count; i++) {
        const key = `${position.getX(i)},${position.getY(i)},${position.getZ(i)}`;
        expect(`${uv.getX(i)},${uv.getY(i)}`).toBe(uvAt.get(key));
      }
    }
  });

  it('沒有 position 就直接擋下來', () => {
    const empty = new BufferGeometry();
    empty.setAttribute('color', new BufferAttribute(new Float32Array(9), 3));
    expect(() => splitGeometry(empty)).toThrow(/position/);
  });

  it('切出來的東西 MultiMesh 直接吃得下', () => {
    // 這一條是接線測試：形狀對不上的話會在建構時炸，而那比在畫面上發現好。
    const source = new PlaneGeometry(100, 100, 40, 40);
    const pieces = splitGeometry(source, { chunks: 9, minTriangles: 16 });
    const mesh = new MultiMesh(pieces, new MeshStandardMaterial());
    expect(mesh.isBatchedMesh).toBe(true);
  });

  it('splitWithLods 每一塊都拿到多階，而且誤差是遞增的', async () => {
    const source = new TorusKnotGeometry(20, 6, 200, 24);
    const sources = await splitWithLods(source, { chunks: 8, minTriangles: 64 });
    expect(sources.length).toBeGreaterThan(1);

    let withChain = 0;
    for (const entry of sources) {
      if (!('lods' in entry)) continue;
      withChain++;
      const errors = entry.errors!;
      for (let i = 1; i < errors.length; i++) {
        // 更粗的階誤差必須更大。反過來的話選階會挑錯，而畫面看起來只是
        // 「遠處怪怪的」。
        expect(errors[i]!).toBeGreaterThanOrEqual(errors[i - 1]!);
      }
      expect(entry.lods.length).toBe(errors.length);
    }
    expect(withChain).toBeGreaterThan(0);
  });

  it('splitWithLods 的結果 MultiMesh 也吃得下', async () => {
    const source = new TorusKnotGeometry(20, 6, 160, 20);
    const sources = await splitWithLods(source, { chunks: 6, minTriangles: 64 });
    const mesh = new MultiMesh(sources, new MeshStandardMaterial());
    expect(mesh.isBatchedMesh).toBe(true);
  });

  it('鎖邊界之後，邊界上的頂點在每一階都還在', async () => {
    // 這是「不會裂」的直接證據。邊界頂點被簡化掉的話，相鄰那一塊的同一條邊
    // 還留著，中間就露出縫 —— 而那只在兩塊選到不同階時才看得到。
    const source = new PlaneGeometry(100, 100, 40, 40);
    const sources = await splitWithLods(source, { chunks: 9, minTriangles: 32 });

    for (const entry of sources) {
      if (!('lods' in entry)) continue;
      const finest = entry.lods[0]!;
      const border = borderVertices(finest);
      expect(border.size).toBeGreaterThan(0);

      const coarsest = entry.lods[entry.lods.length - 1]!;
      const kept = new Set<string>();
      const position = coarsest.getAttribute('position');
      const index = coarsest.getIndex()!;
      for (let i = 0; i < index.count; i++) {
        const v = index.getX(i);
        kept.add(`${position.getX(v)},${position.getY(v)},${position.getZ(v)}`);
      }
      for (const key of border) expect(kept.has(key)).toBe(true);
    }
  });
});

/** 只被一個三角形用到的邊，其兩端就是開放邊界上的頂點。 */
function borderVertices(geometry: BufferGeometry): Set<string> {
  const index = geometry.getIndex()!;
  const position = geometry.getAttribute('position');
  const key = (v: number): string => `${position.getX(v)},${position.getY(v)},${position.getZ(v)}`;
  const edgeUse = new Map<string, number>();
  const edgeEnds = new Map<string, [string, string]>();

  for (let t = 0; t < index.count / 3; t++) {
    const a = key(index.getX(t * 3));
    const b = key(index.getX(t * 3 + 1));
    const c = key(index.getX(t * 3 + 2));
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const id = p < q ? `${p}|${q}` : `${q}|${p}`;
      edgeUse.set(id, (edgeUse.get(id) ?? 0) + 1);
      edgeEnds.set(id, [p, q]);
    }
  }

  const border = new Set<string>();
  for (const [id, uses] of edgeUse) {
    if (uses !== 1) continue;
    const [p, q] = edgeEnds.get(id)!;
    border.add(p);
    border.add(q);
  }
  return border;
}
