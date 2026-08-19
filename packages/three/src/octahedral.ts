import { Vector3 } from 'three';
import { cubeCoordAt } from './cube-sh.ts';
import type { FacePixels } from './cube-sh.ts';

/**
 * 八面體映射：把整個方向球塞進一張正方形的貼圖。
 *
 * ## 為什麼不是 cubemap
 *
 * 反射探針要**很多顆**，而它們必須放在同一張貼圖裡才有辦法一次查完。
 * WebGL2 沒有 cubemap array（`WEBGL_texture_cube_map_array` 不在核心裡），
 * 所以「一顆一張 cubemap」等於「一顆一個 texture unit」—— 那個數量上限是 16。
 *
 * 八面體圖把方向球攤成一張正方形，於是每顆探針只是圖集裡的一小塊。查表是
 * 一次 `texture()`，探針數量與貼圖單元無關。
 *
 * 代價是接縫：球攤平一定會有接縫，而八面體的接縫落在**邊界上**，不像
 * 經緯度投影會在兩極擠成一點。實務上這是攤平方案裡失真最平均的一個。
 *
 * ## 邊界那一圈是必要的，不是保險
 *
 * 雙線性取樣會跨過圖塊的邊 —— 沒有邊界那一圈就會取到隔壁探針的內容。而
 * 八面體的邊在球面上是**接在一起的**（左邊界接的是右邊界的鏡像），所以
 * 那一圈不能只是複製最外圈，要照接法填。
 *
 * 症狀差別很大：填錯只是接縫有一條線，沒填是**隔壁探針的顏色滲進來**。
 */

/** 方向 → 圖塊內的 uv，兩者都在 0…1。方向不必先正規化。 */
export function octEncode(direction: Vector3, target: { u: number; v: number }): { u: number; v: number } {
  const norm = Math.abs(direction.x) + Math.abs(direction.y) + Math.abs(direction.z);
  const inverse = norm > 0 ? 1 / norm : 0;
  let x = direction.x * inverse;
  let y = direction.y * inverse;
  const z = direction.z * inverse;
  if (z < 0) {
    const ax = 1 - Math.abs(y);
    const ay = 1 - Math.abs(x);
    x = x >= 0 ? ax : -ax;
    y = y >= 0 ? ay : -ay;
  }
  target.u = x * 0.5 + 0.5;
  target.v = y * 0.5 + 0.5;
  return target;
}

/** 圖塊內的 uv → 方向（已正規化）。`octEncode` 的反函式。 */
export function octDecode(u: number, v: number, target: Vector3): Vector3 {
  const fx = u * 2 - 1;
  const fy = v * 2 - 1;
  let x = fx;
  let y = fy;
  const z = 1 - Math.abs(fx) - Math.abs(fy);
  if (z < 0) {
    const ax = 1 - Math.abs(fy);
    const ay = 1 - Math.abs(fx);
    x = fx >= 0 ? ax : -ax;
    y = fy >= 0 ? ay : -ay;
  }
  return target.set(x, y, z).normalize();
}

export interface OctahedralResampleOptions {
  /** cubemap 每個面的邊長。 */
  faceSize: number;
  /** 座標系翻轉，與 `projectCubeToSH` 同一個值。WebGL 是 −1。 */
  flip: number;
  /** 像素怎麼變成線性亮度。 */
  decode: (value: number) => number;
  /** 圖塊的內容邊長（不含邊界那一圈）。 */
  tileSize: number;
}

/**
 * 六個面 → 一塊八面體圖，寫進圖集。
 *
 * ## 作法是**潑**，不是查
 *
 * 直覺的做法是「對每個八面體像素，算出方向，去 cubemap 上取樣」。那需要
 * 方向 → 面 + 像素的反函式，而那份反函式與 `cubeCoordAt` 必須完全對稱 ——
 * 兩份程式碼描述同一個約定，遲早會分岔。分岔的症狀是「反射裡的世界跟間接
 * 光裡的世界左右相反」，而那不會報錯。
 *
 * 所以這裡反過來走：對每個 cubemap 像素，用**同一支 `cubeCoordAt`** 算出
 * 方向，潑到對應的八面體像素上。一份程式碼，不可能分岔。
 *
 * 潑的密度：cubemap 有 6 × faceSize² 個來源，圖塊有 tileSize² 個目標。
 * `tileSize === faceSize` 時每個目標平均收到 6 個來源，夠密。
 *
 * @param atlas 目的地，RGBA float32。
 * @param atlasWidth 圖集一列幾個 texel。
 * @param tileX 圖塊左上角在圖集裡的 texel 座標（**含**邊界那一圈）。
 */
export function resampleCubeToOctahedral(
  faces: readonly FacePixels[],
  atlas: Float32Array,
  atlasWidth: number,
  tileX: number,
  tileY: number,
  options: OctahedralResampleOptions,
): void {
  const { faceSize, flip, decode, tileSize } = options;
  const texels = tileSize * tileSize;
  const sums = new Float32Array(texels * 3);
  const counts = new Uint32Array(texels);
  const coord = new Vector3();
  const uv = { u: 0, v: 0 };

  for (let faceIndex = 0; faceIndex < 6; faceIndex++) {
    const data = faces[faceIndex];
    if (data === undefined) continue;
    for (let i = 0; i < faceSize * faceSize * 4; i += 4) {
      cubeCoordAt(faceIndex, i / 4, faceSize, flip, coord);
      octEncode(coord, uv);
      // 夾在最後一格內 —— uv 剛好是 1 的時候（正負 z 的角落）會落到界外。
      const tx = Math.min(tileSize - 1, Math.floor(uv.u * tileSize));
      const ty = Math.min(tileSize - 1, Math.floor(uv.v * tileSize));
      const slot = ty * tileSize + tx;
      sums[slot * 3]! += decode(data[i]!);
      sums[slot * 3 + 1]! += decode(data[i + 1]!);
      sums[slot * 3 + 2]! += decode(data[i + 2]!);
      counts[slot]!++;
    }
  }

  // 寫進圖集的內容區（偏移 1，讓出邊界那一圈）。
  for (let ty = 0; ty < tileSize; ty++) {
    for (let tx = 0; tx < tileSize; tx++) {
      const slot = ty * tileSize + tx;
      const n = counts[slot]!;
      const at = ((tileY + 1 + ty) * atlasWidth + tileX + 1 + tx) * 4;
      if (n === 0) {
        // 一個來源都沒潑到 —— tileSize 開得比 faceSize 大時會發生。留給
        // 下面的補洞處理，先標成無效。
        atlas[at + 3] = 0;
        continue;
      }
      const inverse = 1 / n;
      atlas[at] = sums[slot * 3]! * inverse;
      atlas[at + 1] = sums[slot * 3 + 1]! * inverse;
      atlas[at + 2] = sums[slot * 3 + 2]! * inverse;
      atlas[at + 3] = 1;
    }
  }

  fillHoles(atlas, atlasWidth, tileX, tileY, tileSize);
  writeBorder(atlas, atlasWidth, tileX, tileY, tileSize);
}

/**
 * 沒被潑到的像素用鄰居補。
 *
 * `tileSize` 大於 `faceSize` 時來源不夠密，會留下洞。洞在反射上是**黑點**，
 * 而黑點比模糊難看得多。
 */
function fillHoles(
  atlas: Float32Array,
  atlasWidth: number,
  tileX: number,
  tileY: number,
  tileSize: number,
): void {
  const at = (x: number, y: number): number => ((tileY + 1 + y) * atlasWidth + tileX + 1 + x) * 4;
  for (let pass = 0; pass < 4; pass++) {
    let filled = 0;
    for (let y = 0; y < tileSize; y++) {
      for (let x = 0; x < tileSize; x++) {
        const here = at(x, y);
        if (atlas[here + 3] !== 0) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= tileSize || ny >= tileSize) continue;
          const neighbour = at(nx, ny);
          if (atlas[neighbour + 3] === 0) continue;
          r += atlas[neighbour]!;
          g += atlas[neighbour + 1]!;
          b += atlas[neighbour + 2]!;
          n++;
        }
        if (n === 0) continue;
        atlas[here] = r / n;
        atlas[here + 1] = g / n;
        atlas[here + 2] = b / n;
        atlas[here + 3] = 1;
        filled++;
      }
    }
    if (filled === 0) break;
  }
}

/**
 * 填邊界那一圈，照八面體的接法。
 *
 * 球攤成正方形之後，上邊界接的是**上邊界自己的鏡像**（左右翻轉），四個角
 * 接的是對角。直接複製最外圈的話接縫兩側的內容對不上，而那在鏡面上是一條
 * 很明顯的線。
 */
function writeBorder(
  atlas: Float32Array,
  atlasWidth: number,
  tileX: number,
  tileY: number,
  tileSize: number,
): void {
  const stride = tileSize + 2;
  const at = (x: number, y: number): number => ((tileY + y) * atlasWidth + tileX + x) * 4;
  const copy = (toX: number, toY: number, fromX: number, fromY: number): void => {
    const to = at(toX, toY);
    const from = at(fromX, fromY);
    atlas[to] = atlas[from]!;
    atlas[to + 1] = atlas[from + 1]!;
    atlas[to + 2] = atlas[from + 2]!;
    atlas[to + 3] = atlas[from + 3]!;
  };

  const last = stride - 1;
  for (let i = 1; i <= tileSize; i++) {
    const mirror = stride - 1 - i;
    copy(i, 0, mirror, 1);
    copy(i, last, mirror, tileSize);
    copy(0, i, 1, mirror);
    copy(last, i, tileSize, mirror);
  }
  copy(0, 0, tileSize, tileSize);
  copy(last, 0, 1, tileSize);
  copy(0, last, tileSize, 1);
  copy(last, last, 1, 1);
}

/**
 * 著色器那一份八面體查表。
 *
 * 與 CPU 那一份是同一套公式 —— 而「同一套」有測試守著：GLSL 的正確性沒辦法
 * 直接單元測試，但 CPU 那一份可以，而兩份的公式逐行對得起來。
 */
export const OCTAHEDRAL_GLSL = /* glsl */ `
vec2 wwOctEncode( vec3 direction ) {
  vec3 n = direction / ( abs( direction.x ) + abs( direction.y ) + abs( direction.z ) );
  vec2 p = n.xy;
  if ( n.z < 0.0 ) {
    p = ( 1.0 - abs( vec2( n.y, n.x ) ) ) * vec2( n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0 );
  }
  return p * 0.5 + 0.5;
}
`;
