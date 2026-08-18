import { BoxGeometry, Matrix4, MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { InstancedMesh } from './instanced-mesh.ts';
import { scatter } from './scatter.ts';

/**
 * 擺放規則唯一重要的正確性條件是**決定性**：走出去再走回來，同一格必須
 * 長出一模一樣的東西。
 *
 * 不成立的話症狀是「剛剛那棵樹好像不在這」——不報錯，而且幾乎不可能重現。
 */

function mesh(): InstancedMesh {
  return new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 4, {
    autoLod: false,
  });
}

/** 收集一次 scatter 的結果，只留位置。 */
function run(
  fn: ReturnType<typeof scatter>,
  cx: number,
  cz: number,
  cellSize = 100,
): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  fn(cx, cz, (_mesh, m) => out.push([m.elements[12]!, m.elements[13]!, m.elements[14]!]), cellSize);
  return out;
}

describe('宣告式擺放', () => {
  it('**同一格永遠長出一模一樣的東西** —— 串流走回頭時必須對得上', () => {
    const trees = mesh();
    const fn = scatter([{ mesh: trees, density: 0.01 }]);

    const first = run(fn, 3, -7);
    const second = run(fn, 3, -7);
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });

  it('與呼叫順序無關 —— 先載過別格不會改變這一格', () => {
    // 用一個帶狀態的亂數產生器就會壞在這裡：答案取決於「之前載過哪幾格」。
    // 而那正是串流最常發生的事。
    const trees = mesh();
    const fn = scatter([{ mesh: trees, density: 0.01 }]);

    const alone = run(fn, 5, 5);
    run(fn, 0, 0);
    run(fn, -3, 12);
    run(fn, 99, 99);
    expect(run(fn, 5, 5)).toEqual(alone);
  });

  it('不同的格子長出不同的東西', () => {
    // 全部一樣的話會看到一片重複的圖樣，而那看起來像「內容做得很懶」，
    // 不像 bug。
    const trees = mesh();
    const fn = scatter([{ mesh: trees, density: 0.02 }]);
    expect(run(fn, 0, 0)).not.toEqual(run(fn, 1, 0));
  });

  it('密度是每平方單位 —— 格子調大內容不該跟著變疏', () => {
    // 用「每格幾個」的話，調整 cellSize（那是串流的參數）會讓世界的疏密
    // 跟著變，而那兩件事本來無關。
    const trees = mesh();
    const fn = scatter([{ mesh: trees, density: 0.01 }]);

    const small = run(fn, 0, 0, 100).length; // 面積 10,000 → 約 100
    const big = run(fn, 0, 0, 200).length; // 面積 40,000 → 約 400
    expect(big).toBeGreaterThan(small * 3);
  });

  it('place 回傳 null 就不長 —— 「太陡的地方不長樹」這類規則', () => {
    const trees = mesh();
    const fn = scatter([
      { mesh: trees, density: 0.05, place: ({ x }) => (x > 50 ? null : { y: 7 }) },
    ]);

    const placed = run(fn, 0, 0, 100);
    expect(placed.length).toBeGreaterThan(0);
    for (const [x, y] of placed) {
      expect(x).toBeLessThanOrEqual(50);
      expect(y).toBe(7);
    }
  });

  it('非整數的密度也是決定性的', () => {
    // 小數部分若用「隨機決定要不要多一個」而那個隨機不是位置的函式，
    // 同一格的數量就會每次不同 —— 而那是最難察覺的一種不決定性。
    const trees = mesh();
    const fn = scatter([{ mesh: trees, density: 0.00037 }]);
    const counts = new Set([0, 1, 2, 3].map(() => run(fn, 11, 13).length));
    expect(counts.size).toBe(1);
  });

  it('換 seed 就換一個世界', () => {
    const trees = mesh();
    const a = scatter([{ mesh: trees, density: 0.02 }], { seed: 1 });
    const b = scatter([{ mesh: trees, density: 0.02 }], { seed: 2 });
    expect(run(a, 4, 4)).not.toEqual(run(b, 4, 4));
  });

  it('多條規則各自獨立 —— 樹的位置不會因為加了草而改變', () => {
    const trees = mesh();
    const grass = mesh();
    const onlyTrees = scatter([{ mesh: trees, density: 0.01 }]);
    const both = scatter([
      { mesh: trees, density: 0.01 },
      { mesh: grass, density: 0.05 },
    ]);

    const treesOnly = run(onlyTrees, 2, 2);
    const treePositions: Array<[number, number, number]> = [];
    both(2, 2, (m, matrix) => {
      if (m === trees) {
        treePositions.push([matrix.elements[12]!, matrix.elements[13]!, matrix.elements[14]!]);
      }
    }, 100);

    expect(treePositions).toEqual(treesOnly);
  });

  it('縮放與旋轉也是決定性的', () => {
    const trees = mesh();
    const fn = scatter([{ mesh: trees, density: 0.01, scale: [0.5, 2] }]);
    const read = (): number[] => {
      const out: number[] = [];
      const m = new Matrix4();
      fn(7, 7, (_mesh, matrix) => {
        m.copy(matrix);
        out.push(...m.elements);
      }, 100);
      return out;
    };
    expect(read()).toEqual(read());
  });
});
