import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { octDecode, octEncode, resampleCubeToOctahedral } from './octahedral.ts';
import { cubeCoordAt } from './cube-sh.ts';

/** 固定亂數 —— 測試失敗時要能重現同一組方向。 */
function directions(count: number): Vector3[] {
  let seed = 12345;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const out: Vector3[] = [];
  for (let i = 0; i < count; i++) {
    // 球面均勻取樣。用 z 均勻 + 方位角均勻，不是三個分量各自均勻再正規化
    // （那會偏向對角線）。
    const z = next() * 2 - 1;
    const phi = next() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out.push(new Vector3(r * Math.cos(phi), r * Math.sin(phi), z));
  }
  return out;
}

describe('八面體映射', () => {
  it('encode 之後 decode 回得來', () => {
    const target = { u: 0, v: 0 };
    const back = new Vector3();
    let worst = 0;
    for (const direction of directions(2000)) {
      octEncode(direction, target);
      octDecode(target.u, target.v, back);
      worst = Math.max(worst, back.distanceTo(direction));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('uv 全部落在 0…1 之內', () => {
    const target = { u: 0, v: 0 };
    for (const direction of directions(2000)) {
      octEncode(direction, target);
      expect(target.u).toBeGreaterThanOrEqual(0);
      expect(target.u).toBeLessThanOrEqual(1);
      expect(target.v).toBeGreaterThanOrEqual(0);
      expect(target.v).toBeLessThanOrEqual(1);
    }
  });

  it('+z 在正中央，−z 在四個角', () => {
    const target = { u: 0, v: 0 };
    octEncode(new Vector3(0, 0, 1), target);
    expect(target.u).toBeCloseTo(0.5, 10);
    expect(target.v).toBeCloseTo(0.5, 10);

    // −z 攤開之後跑到四個角。任一個角 decode 回來都該是 −z。
    const back = new Vector3();
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      octDecode(u, v, back);
      expect(back.z).toBeCloseTo(-1, 6);
    }
  });

  it('decode 一整片 uv，方向平均起來是 0 —— 沒有偏向', () => {
    // 偏了的話代表映射有系統性的傾斜，而那在反射上是「整個環境往一邊歪」。
    const sum = new Vector3();
    const direction = new Vector3();
    const size = 64;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        octDecode((x + 0.5) / size, (y + 0.5) / size, direction);
        sum.add(direction);
      }
    }
    sum.divideScalar(size * size);
    expect(sum.length()).toBeLessThan(0.01);
  });
});

describe('cubemap 重取樣進八面體圖', () => {
  /**
   * 六個面各塗一個顏色，重取樣之後每個八面體像素該拿到**它自己那個方向**
   * 主導軸的顏色。
   *
   * 這是整組測試裡唯一抓得到「映射被鏡射或轉了 90 度」的一條 —— 往返測試
   * 對稱地錯掉還是會過，而畫面上的症狀只是「反射裡的世界左右相反」。
   */
  it('每個方向拿到的是那個方向那一面的顏色', () => {
    const faceSize = 16;
    const tileSize = 16;
    const flip = -1;
    // 六個面各一個好認的顏色，紅綠藍三通道編出六個不同的值。
    const colours = [
      [1, 0, 0],
      [0.5, 0, 0],
      [0, 1, 0],
      [0, 0.5, 0],
      [0, 0, 1],
      [0, 0, 0.5],
    ];
    const faces = colours.map(([r, g, b]) => {
      const data = new Float32Array(faceSize * faceSize * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = r!;
        data[i + 1] = g!;
        data[i + 2] = b!;
        data[i + 3] = 1;
      }
      return data;
    });

    const stride = tileSize + 2;
    const atlas = new Float32Array(stride * stride * 4);
    resampleCubeToOctahedral(faces, atlas, stride, 0, 0, {
      faceSize,
      flip,
      decode: (v) => v,
      tileSize,
    });

    // 每個面在單位立方體上的中心方向 —— 用**同一支** cubeCoordAt 算，
    // 所以這條測試驗的是兩邊對得起來，不是我又寫了一份約定。
    const faceDirections = colours.map((_, face) => {
      const middle = (faceSize / 2) * faceSize + faceSize / 2;
      return cubeCoordAt(face, middle, faceSize, flip, new Vector3()).normalize().clone();
    });

    const direction = new Vector3();
    let checked = 0;
    for (let y = 0; y < tileSize; y++) {
      for (let x = 0; x < tileSize; x++) {
        octDecode((x + 0.5) / tileSize, (y + 0.5) / tileSize, direction);

        // 只驗主導軸很明確的像素。接近面與面交界的地方本來就混了兩個顏色，
        // 而那不是錯 —— 一個像素橫跨兩個面時它**應該**是平均。
        let best = -1;
        let second = -1;
        let bestFace = 0;
        faceDirections.forEach((faceDirection, face) => {
          const dot = faceDirection.dot(direction);
          if (dot > best) {
            second = best;
            best = dot;
            bestFace = face;
          } else if (dot > second) {
            second = dot;
          }
        });
        if (best - second < 0.35) continue;

        const at = ((y + 1) * stride + x + 1) * 4;
        const expected = colours[bestFace]!;
        expect(atlas[at + 3]).toBe(1);
        expect(atlas[at]).toBeCloseTo(expected[0]!, 5);
        expect(atlas[at + 1]).toBeCloseTo(expected[1]!, 5);
        expect(atlas[at + 2]).toBeCloseTo(expected[2]!, 5);
        checked++;
      }
    }
    // 驗到的像素要夠多，否則上面那個門檻等於把測試整個跳過。
    expect(checked).toBeGreaterThan(tileSize * tileSize * 0.3);
  });

  it('邊界那一圈照八面體的接法填，而且填滿了', () => {
    const faceSize = 16;
    const tileSize = 16;
    const stride = tileSize + 2;
    const atlas = new Float32Array(stride * stride * 4);
    const faces = [0, 1, 2, 3, 4, 5].map((face) => {
      const data = new Float32Array(faceSize * faceSize * 4);
      const coord = new Vector3();
      for (let i = 0; i < data.length; i += 4) {
        cubeCoordAt(face, i / 4, faceSize, -1, coord).normalize();
        const value = coord.x * 0.5 + 0.5;
        data[i] = value;
        data[i + 1] = value;
        data[i + 2] = value;
        data[i + 3] = 1;
      }
      return data;
    });
    resampleCubeToOctahedral(faces, atlas, stride, 0, 0, {
      faceSize,
      flip: -1,
      decode: (v) => v,
      tileSize,
    });

    const texel = (x: number, y: number): number => atlas[(y * stride + x) * 4]!;
    const alpha = (x: number, y: number): number => atlas[(y * stride + x) * 4 + 3]!;

    // 上下左右照鏡像接，四個角接對角。
    for (let i = 1; i <= tileSize; i++) {
      const mirror = stride - 1 - i;
      expect(texel(i, 0)).toBeCloseTo(texel(mirror, 1), 10);
      expect(texel(i, stride - 1)).toBeCloseTo(texel(mirror, tileSize), 10);
      expect(texel(0, i)).toBeCloseTo(texel(1, mirror), 10);
      expect(texel(stride - 1, i)).toBeCloseTo(texel(tileSize, mirror), 10);
    }
    expect(texel(0, 0)).toBeCloseTo(texel(tileSize, tileSize), 10);
    expect(texel(stride - 1, stride - 1)).toBeCloseTo(texel(1, 1), 10);

    // ## 每一格都要有東西
    //
    // 這是這條測試真正守得住的部分：邊界漏填的話那一圈的 alpha 是 0，而
    // 雙線性取樣讀到它就會把反射拉暗一塊。
    //
    // 「鏡像不等於單純複製最外圈」**量不到**，而我一開始以為量得到。這個
    // 參數化下，左邊界整條映到 xz 平面上的同一個大圓（方向只跟 |fy| 有關），
    // 於是鏡像與同列複製指到同一個方向，值一模一樣 —— 差別是二階的。
    // 鏡像仍然是對的接法，但它不是這條測試證明得了的事，所以不寫成那樣。
    for (let y = 0; y < stride; y++) {
      for (let x = 0; x < stride; x++) {
        expect(alpha(x, y)).toBe(1);
      }
    }
  });

  it('圖塊之間不會互相滲色 —— 那才是邊界那一圈的用途', () => {
    // 兩塊並排，一塊全白一塊全黑。白的那塊連同它的邊界，整片都必須是白的。
    const faceSize = 8;
    const tileSize = 8;
    const stride = tileSize + 2;
    const atlasWidth = stride * 2;
    const atlas = new Float32Array(atlasWidth * stride * 4);
    const solid = (value: number): Float32Array[] =>
      [0, 1, 2, 3, 4, 5].map(() => {
        const data = new Float32Array(faceSize * faceSize * 4);
        data.fill(value);
        return data;
      });

    const options = { faceSize, flip: -1, decode: (v: number) => v, tileSize };
    resampleCubeToOctahedral(solid(1), atlas, atlasWidth, 0, 0, options);
    resampleCubeToOctahedral(solid(0), atlas, atlasWidth, stride, 0, options);

    for (let y = 0; y < stride; y++) {
      for (let x = 0; x < stride; x++) {
        expect(atlas[(y * atlasWidth + x) * 4]).toBe(1);
      }
    }
    // 而且黑的那塊真的是黑的 —— 不然上面那圈斷言可能只是因為第二塊沒寫進去。
    expect(atlas[(0 * atlasWidth + stride) * 4]).toBe(0);
    expect(atlas[(4 * atlasWidth + stride + 4) * 4]).toBe(0);
  });
});
