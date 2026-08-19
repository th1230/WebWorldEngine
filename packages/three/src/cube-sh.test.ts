import { describe, expect, it } from 'vitest';
import { projectCubeToSH } from './cube-sh.ts';

/**
 * 驗這一支的標準答案是**封閉解**，不是那個 addon。
 *
 * 拿 addon 的輸出當標準答案的話，兩邊一起錯就驗不出來 —— 而這一支存在的
 * 理由就是要取代它，所以更不能拿它當真理。
 *
 * 均勻環境的輻照度是 πL，那個答案與任何實作都無關。
 */

const FACE = 8;

/** 六個面都是同一個顏色。 */
function uniform(r: number, g = r, b = r): Float32Array[] {
  return Array.from({ length: 6 }, () => {
    const data = new Float32Array(FACE * FACE * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 1;
    }
    return data;
  });
}

const identity = (v: number): number => v;
const options = { faceSize: FACE, flip: -1, decode: identity };

/** 用 SH 求輻照度，常數與 shader 那一份相同。 */
function irradianceAt(sh: { coefficients: { x: number; y: number; z: number }[] }, n: [number, number, number]): number {
  const c = sh.coefficients;
  return (
    c[0]!.x * 0.886227 + 1.023328 * (c[1]!.x * n[1] + c[2]!.x * n[2] + c[3]!.x * n[0])
  );
}

describe('cubemap → SH', () => {
  it('均勻環境的輻照度是 πL —— 這是封閉解', () => {
    const sh = projectCubeToSH(uniform(1), options);
    // 每個方向都一樣，而且等於 π。
    for (const n of [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
      [-0.577, 0.577, 0.577],
    ] as [number, number, number][]) {
      expect(irradianceAt(sh, n)).toBeCloseTo(Math.PI, 2);
    }
  });

  it('亮度加倍，係數跟著加倍', () => {
    const a = projectCubeToSH(uniform(1), options);
    const b = projectCubeToSH(uniform(2), options);
    expect(b.coefficients[0]!.x).toBeCloseTo(a.coefficients[0]!.x * 2, 6);
  });

  it('均勻環境沒有方向性 —— L1 全部接近 0', () => {
    const sh = projectCubeToSH(uniform(1), options);
    for (let j = 1; j < 4; j++) {
      expect(Math.abs(sh.coefficients[j]!.x)).toBeLessThan(1e-6);
    }
  });

  it('每個顏色通道各走各的', () => {
    const sh = projectCubeToSH(uniform(1, 0.5, 0.25), options);
    expect(sh.coefficients[0]!.x / sh.coefficients[0]!.y).toBeCloseTo(2, 5);
    expect(sh.coefficients[0]!.x / sh.coefficients[0]!.z).toBeCloseTo(4, 5);
  });

  it('只有一個面亮的時候，那個方向最亮', () => {
    // 這一條擋的是「面的順序接錯」與「座標對應寫反」—— 兩種都不會報錯，
    // 只會讓光從錯的方向來。
    const faces = uniform(0);
    // faceIndex 2 是 +y（頭頂）。
    faces[2] = new Float32Array(FACE * FACE * 4).fill(1);
    const sh = projectCubeToSH(faces, options);

    const up = irradianceAt(sh, [0, 1, 0]);
    const down = irradianceAt(sh, [0, -1, 0]);
    expect(up).toBeGreaterThan(down);
    // 而且朝上要明顯比朝側面亮。
    expect(up).toBeGreaterThan(irradianceAt(sh, [1, 0, 0]));
  });

  it('+x 那個面亮的時候，朝 +x 最亮', () => {
    const faces = uniform(0);
    faces[0] = new Float32Array(FACE * FACE * 4).fill(1);
    const sh = projectCubeToSH(faces, options);
    // faceIndex 0 在 WebGL 的翻轉下對應 −x… 所以這裡驗的是「兩側不相等」，
    // 而**哪一側**由 flip 決定 —— 兩個 flip 應該給出相反的結果。
    const plus = irradianceAt(sh, [1, 0, 0]);
    const minus = irradianceAt(sh, [-1, 0, 0]);
    expect(Math.abs(plus - minus)).toBeGreaterThan(0.5);

    const flipped = projectCubeToSH(faces, { ...options, flip: 1 });
    const plusFlipped = irradianceAt(flipped, [1, 0, 0]);
    // 翻轉之後左右對調。
    expect(Math.sign(plus - minus)).toBe(-Math.sign(plusFlipped - irradianceAt(flipped, [-1, 0, 0])));
  });

  it('decode 會被用到 —— 半精度那條路靠它', () => {
    const faces = Array.from({ length: 6 }, () => new Uint16Array(FACE * FACE * 4).fill(2));
    const sh = projectCubeToSH(faces, { ...options, decode: (v) => v / 2 });
    // decode 之後每個像素是 1，所以結果應該與 uniform(1) 相同。
    const reference = projectCubeToSH(uniform(1), options);
    expect(sh.coefficients[0]!.x).toBeCloseTo(reference.coefficients[0]!.x, 6);
  });
});
