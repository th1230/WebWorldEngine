import { describe, expect, it } from 'vitest';
import { splitGeometry } from './split-geometry.ts';

/** 一片 n×n 的格狀平面，攤在 XZ 上。 */
function grid(n: number, size = 100): { positions: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array((n + 1) * (n + 1) * 3);
  for (let z = 0; z <= n; z++) {
    for (let x = 0; x <= n; x++) {
      const i = (z * (n + 1) + x) * 3;
      positions[i] = (x / n - 0.5) * size;
      positions[i + 1] = 0;
      positions[i + 2] = (z / n - 0.5) * size;
    }
  }
  const indices = new Uint32Array(n * n * 6);
  let k = 0;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const a = z * (n + 1) + x;
      indices[k++] = a;
      indices[k++] = a + n + 1;
      indices[k++] = a + 1;
      indices[k++] = a + 1;
      indices[k++] = a + n + 1;
      indices[k++] = a + n + 2;
    }
  }
  return { positions, indices };
}

/** 一塊裡的三角形數。 */
const triangles = (piece: { indices: Uint32Array }): number => piece.indices.length / 3;

describe('切塊', () => {
  it('三角形一個都不多、一個都不少', () => {
    // 這是最不能錯的一條。少了就是**畫面破洞**，多了就是重疊 Z-fighting，
    // 而兩種都只在某些角度看得到。
    const { positions, indices } = grid(40);
    const total = indices.length / 3;
    const pieces = splitGeometry(positions, indices, { chunks: 16 });
    expect(pieces.reduce((sum, p) => sum + triangles(p), 0)).toBe(total);
  });

  it('每個三角形剛好屬於一塊', () => {
    // 用「原始頂點三元組」當身分。同一個三角形出現在兩塊裡的話就會被抓到。
    const { positions, indices } = grid(30);
    const pieces = splitGeometry(positions, indices, { chunks: 16 });
    const seen = new Set<string>();
    for (const piece of pieces) {
      for (let t = 0; t < triangles(piece); t++) {
        const key = [0, 1, 2]
          .map((v) => piece.sourceVertices[piece.indices[t * 3 + v]!]!)
          .sort((a, b) => a - b)
          .join(',');
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
    expect(seen.size).toBe(indices.length / 3);
  });

  it('切出來的頂點座標與原本完全一樣 —— 邊界不能動', () => {
    // 邊界頂點原封不動是**鎖邊界簡化**的前提。這裡先動過的話，之後怎麼鎖
    // 都補不回來，而症狀是相鄰兩塊之間裂開一條縫。
    const { positions, indices } = grid(20);
    const pieces = splitGeometry(positions, indices, { chunks: 8 });
    for (const piece of pieces) {
      for (let i = 0; i < piece.sourceVertices.length; i++) {
        const source = piece.sourceVertices[i]!;
        expect(piece.positions[i * 3]).toBe(positions[source * 3]);
        expect(piece.positions[i * 3 + 1]).toBe(positions[source * 3 + 1]);
        expect(piece.positions[i * 3 + 2]).toBe(positions[source * 3 + 2]);
      }
    }
  });

  it('真的切成好幾塊', () => {
    const { positions, indices } = grid(40);
    const pieces = splitGeometry(positions, indices, { chunks: 16, minTriangles: 8 });
    expect(pieces.length).toBeGreaterThan(4);
  });

  it('每一塊都達到最小三角形數', () => {
    // 沒有這條會生出一堆兩三個三角形的碎塊，而每一塊在 MultiMesh 裡都是
    // 一個 instance —— 碎塊多到一定程度，逐塊的成本會吃掉剔除省下的。
    const { positions, indices } = grid(40);
    const minTriangles = 64;
    const pieces = splitGeometry(positions, indices, { chunks: 64, minTriangles });
    for (const piece of pieces) {
      expect(triangles(piece)).toBeGreaterThanOrEqual(minTriangles);
    }
  });

  it('每一塊只帶自己用到的頂點', () => {
    const { positions, indices } = grid(40);
    const pieces = splitGeometry(positions, indices, { chunks: 16 });
    const sourceVertexCount = positions.length / 3;
    for (const piece of pieces) {
      expect(piece.sourceVertices.length).toBeLessThan(sourceVertexCount);
      // 索引不能指到範圍外。
      for (const index of piece.indices) {
        expect(index).toBeLessThan(piece.sourceVertices.length);
      }
    }
  });

  it('扁的東西不會在薄的那一軸亂切', () => {
    // 平面在 Y 上是零厚度。固定用立方格的話那一軸會切出一堆單層格子，
    // 而那一軸根本不需要切。
    const { positions, indices } = grid(40);
    const pieces = splitGeometry(positions, indices, { chunks: 16, minTriangles: 4 });
    // 每一塊的 Y 都是 0，所以只要塊數合理就代表沒有在 Y 上亂分。
    for (const piece of pieces) {
      for (let i = 1; i < piece.positions.length; i += 3) {
        expect(piece.positions[i]).toBe(0);
      }
    }
    expect(pieces.length).toBeLessThanOrEqual(40);
  });

  it('內容太小就不切，回傳原本那一份', () => {
    const { positions, indices } = grid(4);
    const pieces = splitGeometry(positions, indices, { chunks: 16, minTriangles: 64 });
    expect(pieces).toHaveLength(1);
    expect(triangles(pieces[0]!)).toBe(indices.length / 3);
  });

  it('chunks 是 1 就不切', () => {
    const { positions, indices } = grid(20);
    const pieces = splitGeometry(positions, indices, { chunks: 1 });
    expect(pieces).toHaveLength(1);
  });

  it('沒有索引的幾何也能切', () => {
    const { positions, indices } = grid(20);
    const flat = new Float32Array(indices.length * 3);
    for (let i = 0; i < indices.length; i++) {
      flat[i * 3] = positions[indices[i]! * 3]!;
      flat[i * 3 + 1] = positions[indices[i]! * 3 + 1]!;
      flat[i * 3 + 2] = positions[indices[i]! * 3 + 2]!;
    }
    const pieces = splitGeometry(flat, null, { chunks: 9, minTriangles: 8 });
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.reduce((sum, p) => sum + triangles(p), 0)).toBe(indices.length / 3);
  });

  it('塊在空間上是分開的，不是隨便亂分', () => {
    // 切塊的價值全部來自「一塊在空間上是連在一起的」—— 那樣剔除與選階才問
    // 得出有意義的答案。亂分的話每一塊的外接盒都跟整份幾何一樣大，切了等於
    // 沒切，而三角形數量那幾條測試照樣會過。
    const { positions, indices } = grid(40);
    const pieces = splitGeometry(positions, indices, { chunks: 16, minTriangles: 16 });
    let sumExtent = 0;
    for (const piece of pieces) {
      let minX = Infinity;
      let maxX = -Infinity;
      for (let i = 0; i < piece.positions.length; i += 3) {
        const x = piece.positions[i]!;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
      sumExtent += maxX - minX;
    }
    // 每一塊平均的 X 跨度要明顯小於整份的 100。
    expect(sumExtent / pieces.length).toBeLessThan(50);
  });
});
