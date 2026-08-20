/**
 * 內接盒：一個**確定整個在實體內部**的軸對齊盒子。
 *
 * ## 為什麼不能用外接盒
 *
 * 遮蔽物必須比物體**小**。外接盒比物體大，拿它當遮蔽物會擋掉物體其實遮不到
 * 的東西 —— 而症狀是畫面上有東西一閃一閃地消失，那是最難查也最傷的一種錯。
 *
 * 遮蔽剔除的兩種錯不對稱：
 *
 * | 錯法 | 後果 |
 * | --- | --- |
 * | 遮蔽物太小 | 少剔一點，慢一點 |
 * | 遮蔽物太大 | **東西不見了** |
 *
 * 所以這裡算的是內接，而且每一步都往小的方向倒。
 *
 * ## 為什麼放在 `format`
 *
 * 與 `maxSurfaceDeviation` 同一個理由：這個盒子的**意義**是資產契約的一部分。
 * cook 出來的資產要能帶著它，執行期算的那一份必須與 cook 算的是同一個東西
 * ——兩邊各寫一份「差不多的內接盒」的話，同一個模型在兩條路上會遮住不同的
 * 東西，而那個差異不會報錯。
 *
 * ## 做法：體素化，然後找最大的內部方塊
 *
 * 1. 把三角形碰到的體素標成「表面」。
 * 2. 從格子邊界**灌水**，穿得過去的都是外面。
 * 3. 剩下的既不是表面也灌不到 —— 那就是裡面。
 * 4. 在「裡面」那堆體素裡找一個大盒子。
 *
 * 灌水的好處是**破面的模型會自然失敗**：水從破洞漏進去，內部被標成外面，
 * 於是算不出盒子。那是安全的失敗方向 —— 沒有遮蔽物只是少剔一點。
 *
 * 用射線判斷內外就沒有這個性質：破面的模型會給出隨機的內外，而那會產生
 * 一個**錯的**盒子。
 */

export interface InnerBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface InnerBoxOptions {
  /**
   * 每一軸切幾格。預設 24。
   *
   * 這個數字決定的是**精度與時間**：格子越細內接盒越貼近實體（遮得越多），
   * 但體素化的成本是三次方。24³ 是 13,824 個體素，對一個要在載入時算一次的
   * 東西是合理的。
   */
  resolution?: number;
  /**
   * 額外往內縮多少（世界單位）。預設 0。
   *
   * 用途是把 LOD 的幾何誤差扣掉：實際畫出去的是簡化過的幾何，它可能比原始
   * 網格**凹進去**一點，而內接盒必須連那一份也在裡面。
   */
  margin?: number;
}

/**
 * 算一個確定在網格內部的盒子。
 *
 * @returns 找不到就回 `null` —— 太薄的、破面的、平面的都會這樣。呼叫端要
 *   把它當成「這個東西不能當遮蔽物」，而不是錯誤。
 */
export function innerBox(
  positions: ArrayLike<number>,
  indices: ArrayLike<number> | null,
  options: InnerBoxOptions = {},
): InnerBox | null {
  const n = options.resolution ?? 24;
  const margin = options.margin ?? 0;
  const triangleCount = indices !== null ? indices.length / 3 : positions.length / 9;
  if (triangleCount < 4 || n < 3) return null;

  // 外接盒。
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
  const sizeX = maxX - minX;
  const sizeY = maxY - minY;
  const sizeZ = maxZ - minZ;
  if (!(sizeX > 0 && sizeY > 0 && sizeZ > 0)) return null;

  const cellX = sizeX / n;
  const cellY = sizeY / n;
  const cellZ = sizeZ / n;

  // 0 = 未知、1 = 表面、2 = 外面
  const grid = new Uint8Array(n * n * n);
  const at = (x: number, y: number, z: number): number => (z * n + y) * n + x;

  // ## 1. 標出表面
  //
  // 用三角形的外接盒標，不做精確的三角形／體素相交測試。標多了只是讓內部
  // 變小 —— 又是往安全的方向倒。
  const tri = new Float64Array(9);
  for (let t = 0; t < triangleCount; t++) {
    for (let v = 0; v < 3; v++) {
      const index = indices !== null ? indices[t * 3 + v]! : t * 3 + v;
      tri[v * 3] = positions[index * 3]!;
      tri[v * 3 + 1] = positions[index * 3 + 1]!;
      tri[v * 3 + 2] = positions[index * 3 + 2]!;
    }
    const tx0 = clampIndex(Math.floor((Math.min(tri[0]!, tri[3]!, tri[6]!) - minX) / cellX), n);
    const tx1 = clampIndex(Math.floor((Math.max(tri[0]!, tri[3]!, tri[6]!) - minX) / cellX), n);
    const ty0 = clampIndex(Math.floor((Math.min(tri[1]!, tri[4]!, tri[7]!) - minY) / cellY), n);
    const ty1 = clampIndex(Math.floor((Math.max(tri[1]!, tri[4]!, tri[7]!) - minY) / cellY), n);
    const tz0 = clampIndex(Math.floor((Math.min(tri[2]!, tri[5]!, tri[8]!) - minZ) / cellZ), n);
    const tz1 = clampIndex(Math.floor((Math.max(tri[2]!, tri[5]!, tri[8]!) - minZ) / cellZ), n);
    for (let z = tz0; z <= tz1; z++) {
      for (let y = ty0; y <= ty1; y++) {
        for (let x = tx0; x <= tx1; x++) grid[at(x, y, z)] = 1;
      }
    }
  }

  // ## 2. 從邊界灌水
  //
  // 破面的模型水會漏進去，於是內部被標成外面 —— 算不出盒子，而那正是想要的
  // 失敗方向。
  const stack: number[] = [];
  const push = (x: number, y: number, z: number): void => {
    if (x < 0 || y < 0 || z < 0 || x >= n || y >= n || z >= n) return;
    const index = at(x, y, z);
    if (grid[index] !== 0) return;
    grid[index] = 2;
    stack.push(index);
  };
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (x === 0 || y === 0 || z === 0 || x === n - 1 || y === n - 1 || z === n - 1)
          push(x, y, z);
      }
    }
  }
  while (stack.length > 0) {
    const index = stack.pop()!;
    const x = index % n;
    const y = ((index / n) | 0) % n;
    const z = (index / (n * n)) | 0;
    push(x + 1, y, z);
    push(x - 1, y, z);
    push(x, y + 1, z);
    push(x, y - 1, z);
    push(x, y, z + 1);
    push(x, y, z - 1);
  }

  // ## 3. 在內部體素裡找一個大盒子
  //
  // 真正的「最大內接長方體」是個組合最佳化問題。這裡用一個便宜的近似：先找
  // 內部最深的那個點（離表面最遠），再從它往六個方向逐層長，長到碰壁為止。
  //
  // 近似不夠大只是少剔一點 —— 方向仍然是安全的。
  const seed = deepestInside(grid, n);
  if (seed === null) return null;

  let [x0, y0, z0] = seed;
  let x1 = x0;
  let y1 = y0;
  let z1 = z0;
  const inside = (x: number, y: number, z: number): boolean => grid[at(x, y, z)] === 0;
  let grew = true;
  while (grew) {
    grew = false;
    if (x0 > 0 && slabInside(inside, x0 - 1, x0 - 1, y0, y1, z0, z1)) {
      x0--;
      grew = true;
    }
    if (x1 < n - 1 && slabInside(inside, x1 + 1, x1 + 1, y0, y1, z0, z1)) {
      x1++;
      grew = true;
    }
    if (y0 > 0 && slabInside(inside, x0, x1, y0 - 1, y0 - 1, z0, z1)) {
      y0--;
      grew = true;
    }
    if (y1 < n - 1 && slabInside(inside, x0, x1, y1 + 1, y1 + 1, z0, z1)) {
      y1++;
      grew = true;
    }
    if (z0 > 0 && slabInside(inside, x0, x1, y0, y1, z0 - 1, z0 - 1)) {
      z0--;
      grew = true;
    }
    if (z1 < n - 1 && slabInside(inside, x0, x1, y0, y1, z1 + 1, z1 + 1)) {
      z1++;
      grew = true;
    }
  }

  // ## 4. 換回世界座標，而且往內縮一格
  //
  // 體素是「整格都在裡面」的解析度，但格子邊界上的實體位置是未知的 ——
  // 一個標成內部的體素，它的角可能剛好貼著表面。縮一格把那個不確定吃掉。
  const box: InnerBox = {
    minX: minX + (x0 + 1) * cellX + margin,
    minY: minY + (y0 + 1) * cellY + margin,
    minZ: minZ + (z0 + 1) * cellZ + margin,
    maxX: minX + x1 * cellX - margin,
    maxY: minY + y1 * cellY - margin,
    maxZ: minZ + z1 * cellZ - margin,
  };
  if (box.maxX <= box.minX || box.maxY <= box.minY || box.maxZ <= box.minZ) return null;
  return box;
}

function clampIndex(v: number, n: number): number {
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}

function slabInside(
  inside: (x: number, y: number, z: number) => boolean,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): boolean {
  for (let z = z0; z <= z1; z++) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!inside(x, y, z)) return false;
      }
    }
  }
  return true;
}

/**
 * 找離表面最遠的那個內部體素，用切比雪夫距離的逐層擴張。
 *
 * 從那裡開始長，長出來的盒子比從質心開始長的大 —— 質心在 L 形或環形的物體
 * 上可能根本不在內部。
 */
function deepestInside(grid: Uint8Array, n: number): [number, number, number] | null {
  const distance = new Int32Array(n * n * n).fill(-1);
  const at = (x: number, y: number, z: number): number => (z * n + y) * n + x;
  let frontier: number[] = [];

  // 第 0 層：所有非內部的體素。
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== 0) {
      distance[i] = 0;
      frontier.push(i);
    }
  }
  if (frontier.length === grid.length) return null;

  let best = -1;
  let bestIndex = -1;
  let step = 0;
  while (frontier.length > 0) {
    step++;
    const next: number[] = [];
    for (const index of frontier) {
      const x = index % n;
      const y = ((index / n) | 0) % n;
      const z = (index / (n * n)) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            const nz = z + dz;
            if (nx < 0 || ny < 0 || nz < 0 || nx >= n || ny >= n || nz >= n) continue;
            const ni = at(nx, ny, nz);
            if (distance[ni] !== -1) continue;
            distance[ni] = step;
            next.push(ni);
            if (step > best) {
              best = step;
              bestIndex = ni;
            }
          }
        }
      }
    }
    frontier = next;
  }

  if (bestIndex < 0) return null;
  return [bestIndex % n, ((bestIndex / n) | 0) % n, (bestIndex / (n * n)) | 0];
}
