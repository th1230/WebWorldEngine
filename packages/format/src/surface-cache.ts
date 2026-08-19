/**
 * 表面快取：記住「這附近的表面是什麼顏色」。
 *
 * ## 它是多次反彈缺的那一半
 *
 * 距離場能回答「這個方向有沒有東西擋著」，但答不出**那個東西是什麼顏色**。
 * 而沒有顏色就只能做遮蔽，做不了反彈 —— 一面紅牆與一面白牆對它是一樣的。
 *
 * Lumen 把這件事叫 surface cache：每個物件表面的光照被存下來，追蹤打到的
 * 時候直接查，不必再往下追一層。
 *
 * 那正是「反彈的光再反彈」為什麼便宜的原因：第二次反彈不是再追一次，是
 * **查一次表**。
 *
 * ## 這裡存的是反照率，不是光照
 *
 * Lumen 存的是算好的表面光照（含直接光）。這裡存反照率，追蹤打到的時候
 * 乘上那一點的輻照度（來自 `IrradianceVolume`）才得到射出的光。
 *
 * 這樣分的理由是**光會變而反照率不會**：光源動了、探針重烘了，這份快取
 * 完全不用動。存算好的光照的話每次光一變整份都過期。
 *
 * 代價是查一次要多乘一次輻照度 —— 而那本來就要查（要知道那一點多亮）。
 */

export interface SurfaceCacheOptions {
  /**
   * 每一軸幾格。預設 16。
   *
   * 比距離場更粗是刻意的：這裡答的是「那一塊大概什麼顏色」，而反彈光本來
   * 就是低頻的。存細節只是浪費記憶體 —— 反彈到別的表面上之後也看不出來。
   */
  resolution?: number;
  /** 與距離場對齊用的外擴比例。**必須與距離場相同**，否則兩者對不上。 */
  padding?: number;
}

export interface SurfaceCache {
  /** 每格 RGB。沒有表面的格子是 0。 */
  data: Float32Array;
  resolution: number;
  min: [number, number, number];
  size: [number, number, number];
}

/**
 * 把每個三角形的顏色刷進它碰到的格子。
 *
 * @param colors 每個**頂點**的 RGB。沒有的話用 `flat` 給一個統一色。
 */
export function bakeSurfaceCache(
  positions: ArrayLike<number>,
  indices: ArrayLike<number> | null,
  colors: ArrayLike<number> | null,
  options: SurfaceCacheOptions & { flat?: [number, number, number] } = {},
): SurfaceCache {
  const n = Math.max(4, Math.floor(options.resolution ?? 16));
  const padding = options.padding ?? 0.25;
  const flat = options.flat ?? [1, 1, 1];
  const triangleCount = indices !== null ? Math.floor(indices.length / 3) : Math.floor(positions.length / 9);

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const spanZ = Math.max(maxZ - minZ, 1e-6);
  const originX = minX - spanX * padding;
  const originY = minY - spanY * padding;
  const originZ = minZ - spanZ * padding;
  const sizeX = spanX * (1 + padding * 2);
  const sizeY = spanY * (1 + padding * 2);
  const sizeZ = spanZ * (1 + padding * 2);

  const total = n * n * n;
  const data = new Float32Array(total * 3);
  // 同一格可能被好幾個三角形碰到 —— 取平均，不是最後一個蓋掉前面的。
  // 蓋掉的話結果會跟著三角形順序走，而那個順序是沒有意義的。
  const counts = new Float32Array(total);

  const cellX = sizeX / n;
  const cellY = sizeY / n;
  const cellZ = sizeZ / n;

  for (let t = 0; t < triangleCount; t++) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let v = 0; v < 3; v++) {
      const index = indices !== null ? indices[t * 3 + v]! : t * 3 + v;
      cx += positions[index * 3]!;
      cy += positions[index * 3 + 1]!;
      cz += positions[index * 3 + 2]!;
      if (colors !== null) {
        r += colors[index * 3]!;
        g += colors[index * 3 + 1]!;
        b += colors[index * 3 + 2]!;
      }
    }
    if (colors === null) {
      r = flat[0] * 3;
      g = flat[1] * 3;
      b = flat[2] * 3;
    }

    const gx = clamp(Math.floor((cx / 3 - originX) / cellX), n);
    const gy = clamp(Math.floor((cy / 3 - originY) / cellY), n);
    const gz = clamp(Math.floor((cz / 3 - originZ) / cellZ), n);
    const cell = (gz * n + gy) * n + gx;
    data[cell * 3] = data[cell * 3]! + r / 3;
    data[cell * 3 + 1] = data[cell * 3 + 1]! + g / 3;
    data[cell * 3 + 2] = data[cell * 3 + 2]! + b / 3;
    counts[cell] = counts[cell]! + 1;
  }

  for (let i = 0; i < total; i++) {
    const count = counts[i]!;
    if (count === 0) continue;
    data[i * 3] = data[i * 3]! / count;
    data[i * 3 + 1] = data[i * 3 + 1]! / count;
    data[i * 3 + 2] = data[i * 3 + 2]! / count;
  }

  // ## 擴散到填滿，不是只擴一格
  //
  // 第一版只擴一格，理由寫的是「塗滿的話任何方向都拿得到顏色，等於把幾何
  // 資訊丟掉了」。**那個理由是錯的** —— 這份快取從來不負責回答「那裡有沒有
  // 東西」，那是距離場的事。它只回答「那是什麼顏色」，而且只在追蹤已經
  // 判定打到之後才被查。
  //
  // 錯的代價是實測出來的：全域距離場是照格心取樣的，而格心多半**不在**
  // 那一格厚的殼上，於是整份全域反照率幾乎都是 0 —— 反射到紅箱子拿到全黑。
  //
  // 填滿之後它是一份「最近的表面是什麼顏色」的場，那正是要的東西。
  floodFill(data, counts, n);

  return {
    data,
    resolution: n,
    min: [originX, originY, originZ],
    size: [sizeX, sizeY, sizeZ],
  };
}

function clamp(v: number, n: number): number {
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}

/**
 * 把顏色擴散到整份場：每一格填「最近的那個表面的顏色」。
 *
 * 一輪只擴一層，重複到沒有空格為止。上限是邊長 —— 再多就代表整份都是空的
 * （沒有任何三角形），那時候留著 0 是對的。
 */
function floodFill(data: Float32Array, counts: Float32Array, n: number): void {
  const filled = counts.slice();
  const at = (x: number, y: number, z: number): number => (z * n + y) * n + x;

  for (let pass = 0; pass < n; pass++) {
    let empty = 0;
    const before = filled.slice();
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const index = at(x, y, z);
          if (before[index]! > 0) continue;
          let r = 0;
          let g = 0;
          let b = 0;
          let found = 0;
          for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                const nz = z + dz;
                if (nx < 0 || ny < 0 || nz < 0 || nx >= n || ny >= n || nz >= n) continue;
                const ni = at(nx, ny, nz);
                if (before[ni]! === 0) continue;
                r += data[ni * 3]!;
                g += data[ni * 3 + 1]!;
                b += data[ni * 3 + 2]!;
                found++;
              }
            }
          }
          if (found === 0) {
            empty++;
            continue;
          }
          data[index * 3] = r / found;
          data[index * 3 + 1] = g / found;
          data[index * 3 + 2] = b / found;
          filled[index] = 1;
        }
      }
    }
    if (empty === 0) break;
  }
}
