/**
 * 量一份簡化過的網格**真正**偏離原始網格多遠。
 *
 * ## 為什麼不能用簡化器回報的那個數字
 *
 * meshoptimizer 的 `simplify()` 回傳一個誤差，而整個品質契約（「被選中的階，
 * 幾何誤差投影到螢幕 ≤ 2 像素」）就建立在它上面。但那是**估計值，不是上界**。
 *
 * 拿有封閉解的幾何當真值量過（icosphere，頂點都在同一顆球上，所以誤差就是
 * 矢高）：
 *
 * | 產生的階 | meshopt 說 | 真值 | |
 * | ---: | ---: | ---: | --- |
 * | 250 面 | 0.0385 | 0.0556 | 低估 1.44 倍 |
 * | 50 面 | 0.1408 | 0.2079 | **低估 1.48 倍** |
 * | 12 面 | 0.3932 | 0.5305 | 低估 1.35 倍 |
 *
 * 每一階都低估，所以實際的契約是「≤ 大約 3 像素」而不是宣稱的 2 像素。
 * **低估誤差不會有任何東西報錯**，只是畫面比宣稱的糊 —— 正是這個專案最怕的
 * 那一類。
 *
 * ## 量的是哪個方向
 *
 * 原始網格的每一個頂點，到簡化後**表面**的最近距離，取最大值。
 *
 * 那是單向的 Hausdorff 距離。真正的 Hausdorff 要兩個方向都取，但簡化只會
 * 移除頂點不會新增，所以「簡化後的點到原始表面」那個方向通常更小 —— 而且
 * 這個方向抓的正是我們在意的：**原本凸出來的細節被削掉了多少**。
 *
 * ## 為什麼不量到最近的頂點就好
 *
 * 那樣便宜很多（不必算點到三角形），而且是安全的方向（高估）。但高估得太
 * 兇：icosphere 簡化到 20 面時，最近頂點的距離約是粗網格的邊長 1.05，而真正
 * 的偏離只有 0.378 —— **2.8 倍的浪費**，換算成選階就是永遠挑太細的階。
 *
 * 安全但過度保守的估計，代價是所有人的效能。所以算點到三角形。
 *
 * ## 為什麼要空間格
 *
 * 逐一比對是 O(頂點數 × 三角形數)。第一階簡化後還有一半的三角形，10 萬個
 * 頂點對 5 萬個三角形就是 50 億次 —— 那會讓 LOD 產生從幾毫秒變成幾十秒。
 *
 * 格子讓每次查詢只碰附近的幾個三角形。查詢時一圈一圈往外找，當「下一圈最近
 * 也不可能比現在的答案更近」時就停 —— 那個提前結束是正確的，不是近似。
 */

/** 三角形網格。`positions` 是 xyz 連續排列。 */
export interface TriangleMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * 原始頂點到簡化表面的最大距離，世界單位。
 *
 * @param sourcePositions 原始網格的頂點，xyz 連續排列。
 * @param simplified 簡化後的網格。
 */
export function maxSurfaceDeviation(
  sourcePositions: Float32Array,
  simplified: TriangleMesh,
): number {
  const triangleCount = simplified.indices.length / 3;
  if (triangleCount === 0 || sourcePositions.length === 0) return 0;

  const grid = buildGrid(simplified, triangleCount);
  let worst = 0;

  for (let i = 0; i < sourcePositions.length; i += 3) {
    const distance = nearestDistance(
      sourcePositions[i]!,
      sourcePositions[i + 1]!,
      sourcePositions[i + 2]!,
      simplified,
      grid,
    );
    if (distance > worst) worst = distance;
  }
  return Math.sqrt(worst);
}

interface Grid {
  minX: number;
  minY: number;
  minZ: number;
  cell: number;
  nx: number;
  ny: number;
  nz: number;
  /** 每一格的三角形在 `items` 裡的起點，長度 = 格數 + 1。 */
  starts: Int32Array;
  items: Int32Array;
}

/**
 * 用計數排序把三角形分進格子 —— 兩趟（先數再填），沒有逐格的動態陣列。
 *
 * 一個三角形會進它 AABB 覆蓋到的每一格。那會重複，但重複的量有界：粗網格的
 * 三角形大，格子邊長是照三角形數推出來的，所以每個三角形大約落在常數個格子裡。
 */
function buildGrid(mesh: TriangleMesh, triangleCount: number): Grid {
  const { positions, indices } = mesh;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < indices.length; i++) {
    const p = indices[i]! * 3;
    const x = positions[p]!;
    const y = positions[p + 1]!;
    const z = positions[p + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  // 格子邊長取「把包圍盒切成大約三角形數那麼多格」的邊長。太細會讓一個
  // 三角形跨很多格（記憶體與重複比對），太粗會讓每格裝太多三角形。
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  const cell = Math.max(extent / Math.max(Math.cbrt(triangleCount), 1), extent * 1e-4);
  const nx = Math.max(1, Math.min(128, Math.ceil((maxX - minX) / cell) + 1));
  const ny = Math.max(1, Math.min(128, Math.ceil((maxY - minY) / cell) + 1));
  const nz = Math.max(1, Math.min(128, Math.ceil((maxZ - minZ) / cell) + 1));

  const cellCount = nx * ny * nz;
  const counts = new Int32Array(cellCount + 1);
  const clampX = (v: number): number => (v < 0 ? 0 : v >= nx ? nx - 1 : v);
  const clampY = (v: number): number => (v < 0 ? 0 : v >= ny ? ny - 1 : v);
  const clampZ = (v: number): number => (v < 0 ? 0 : v >= nz ? nz - 1 : v);

  // 第一趟：數每一格有幾個。
  let total = 0;
  for (let t = 0; t < triangleCount; t++) {
    const box = triangleBox(mesh, t);
    const x0 = clampX(Math.floor((box[0]! - minX) / cell));
    const x1 = clampX(Math.floor((box[3]! - minX) / cell));
    const y0 = clampY(Math.floor((box[1]! - minY) / cell));
    const y1 = clampY(Math.floor((box[4]! - minY) / cell));
    const z0 = clampZ(Math.floor((box[2]! - minZ) / cell));
    const z1 = clampZ(Math.floor((box[5]! - minZ) / cell));
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          counts[(z * ny + y) * nx + x + 1]!++;
          total++;
        }
      }
    }
  }
  for (let i = 1; i <= cellCount; i++) counts[i]! += counts[i - 1]!;

  // 第二趟：填。`cursor` 是每格的寫入位置，填完就等於下一格的起點。
  const starts = counts;
  const cursor = Int32Array.from(starts.subarray(0, cellCount));
  const items = new Int32Array(total);
  for (let t = 0; t < triangleCount; t++) {
    const box = triangleBox(mesh, t);
    const x0 = clampX(Math.floor((box[0]! - minX) / cell));
    const x1 = clampX(Math.floor((box[3]! - minX) / cell));
    const y0 = clampY(Math.floor((box[1]! - minY) / cell));
    const y1 = clampY(Math.floor((box[4]! - minY) / cell));
    const z0 = clampZ(Math.floor((box[2]! - minZ) / cell));
    const z1 = clampZ(Math.floor((box[5]! - minZ) / cell));
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          items[cursor[(z * ny + y) * nx + x]!++] = t;
        }
      }
    }
  }

  return { minX, minY, minZ, cell, nx, ny, nz, starts, items };
}

const box = new Float64Array(6);

function triangleBox(mesh: TriangleMesh, t: number): Float64Array {
  const { positions, indices } = mesh;
  box[0] = box[1] = box[2] = Infinity;
  box[3] = box[4] = box[5] = -Infinity;
  for (let corner = 0; corner < 3; corner++) {
    const p = indices[t * 3 + corner]! * 3;
    for (let axis = 0; axis < 3; axis++) {
      const v = positions[p + axis]!;
      if (v < box[axis]!) box[axis] = v;
      if (v > box[axis + 3]!) box[axis + 3] = v;
    }
  }
  return box;
}

/**
 * 一個點到網格的最近距離**平方**。
 *
 * 一圈一圈往外找。第 r 圈以外的三角形至少有 `(r - 1) * cell` 遠（減 1 是因為
 * 點不一定在自己那格的中心），所以當現在的答案已經比那個近時就可以停 ——
 * 這是提前結束，不是近似。
 */
function nearestDistance(
  px: number,
  py: number,
  pz: number,
  mesh: TriangleMesh,
  grid: Grid,
): number {
  const { minX, minY, minZ, cell, nx, ny, nz, starts, items } = grid;
  const cx = clamp(Math.floor((px - minX) / cell), nx);
  const cy = clamp(Math.floor((py - minY) / cell), ny);
  const cz = clamp(Math.floor((pz - minZ) / cell), nz);

  let best = Infinity;
  const maxRing = Math.max(nx, ny, nz);
  for (let ring = 0; ring <= maxRing; ring++) {
    if (best < Infinity) {
      const reachable = (ring - 1) * cell;
      if (reachable > 0 && reachable * reachable > best) break;
    }
    for (let z = cz - ring; z <= cz + ring; z++) {
      if (z < 0 || z >= nz) continue;
      for (let y = cy - ring; y <= cy + ring; y++) {
        if (y < 0 || y >= ny) continue;
        for (let x = cx - ring; x <= cx + ring; x++) {
          if (x < 0 || x >= nx) continue;
          // 只看這一圈新加的殼，裡面的格子上一圈已經走過了。
          const onShell =
            ring === 0 ||
            x === cx - ring ||
            x === cx + ring ||
            y === cy - ring ||
            y === cy + ring ||
            z === cz - ring ||
            z === cz + ring;
          if (!onShell) continue;
          const index = (z * ny + y) * nx + x;
          for (let i = starts[index]!; i < starts[index + 1]!; i++) {
            const d = pointTriangleDistanceSq(px, py, pz, mesh, items[i]!);
            if (d < best) best = d;
          }
        }
      }
    }
  }
  return best === Infinity ? 0 : best;
}

function clamp(v: number, n: number): number {
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}

/**
 * 點到三角形的最近距離平方（Ericson，Real-Time Collision Detection 5.1.5）。
 *
 * 分七種情況：三個頂點、三條邊、面內部。少任何一種都會在某些角度回報過大的
 * 距離，而那個方向是「誤差被高估」—— 安全但浪費，且很難察覺。
 */
function pointTriangleDistanceSq(
  px: number,
  py: number,
  pz: number,
  mesh: TriangleMesh,
  triangle: number,
): number {
  const { positions, indices } = mesh;
  const ia = indices[triangle * 3]! * 3;
  const ib = indices[triangle * 3 + 1]! * 3;
  const ic = indices[triangle * 3 + 2]! * 3;
  const ax = positions[ia]!;
  const ay = positions[ia + 1]!;
  const az = positions[ia + 2]!;
  const bx = positions[ib]!;
  const by = positions[ib + 1]!;
  const bz = positions[ib + 2]!;
  const cx = positions[ic]!;
  const cy = positions[ic + 1]!;
  const cz = positions[ic + 2]!;

  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;

  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return lengthSq(apx - v * abx, apy - v * aby, apz - v * abz);
  }

  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return lengthSq(apx - w * acx, apy - w * acy, apz - w * acz);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return lengthSq(bpx - w * (cx - bx), bpy - w * (cy - by), bpz - w * (cz - bz));
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return lengthSq(apx - (v * abx + w * acx), apy - (v * aby + w * acy), apz - (v * abz + w * acz));
}

function lengthSq(x: number, y: number, z: number): number {
  return x * x + y * y + z * z;
}
