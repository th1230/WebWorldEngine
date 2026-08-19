/**
 * 有號距離場：每一格記「離最近的表面多遠」，裡面是負的。
 *
 * ## 它補的是螢幕空間補不到的那一段
 *
 * `ScreenSpaceGI` 只收集得到**畫面上有的**東西 —— 鏡頭外的牆不會擋光，也不
 * 會反彈光。那是螢幕空間這個做法的本質限制。
 *
 * 距離場不看畫面：光線在一個三維的場裡行進，鏡頭外的東西照樣擋得住它。
 * 這就是 Lumen 那一類做法裡**真正可以搬過來的那一半** —— 它是資料（怎麼烘、
 * 怎麼存、怎麼串流），而資料正是 [ADR-0001](../../../specs/adr/0001-three-as-adapter.md)
 * 說要我們自己建的。
 *
 * 追蹤那一步是一個後製 pass，與 `ScreenSpaceGI` 同一類，不碰渲染管線。
 *
 * ## 為什麼距離場可以「大步走」
 *
 * 每一格記的是到最近表面的距離，所以站在任何一點都知道**至少可以安全走多遠**
 * 而不會穿過東西。於是光線行進不必一小步一小步試，可以直接跳那個距離 ——
 * 空曠的地方一兩步就跨過去，貼近表面時自動變細。
 *
 * 這就是為什麼它比體素射線便宜：步數跟著幾何的疏密走，不跟著距離走。
 *
 * ## 精度與格數
 *
 * 距離場是**低頻**的東西 —— 它要回答的是「附近有沒有東西擋著」，不是
 * 「表面長什麼樣」。所以格子可以很粗；細節那一段本來就由螢幕空間那條路管。
 */

export interface DistanceFieldOptions {
  /**
   * 每一軸幾格。預設 32。
   *
   * 三次方成長：32 是 32,768 格，64 是 262,144。而這個東西**不需要細** ——
   * 它管的是「附近有沒有東西」，細節歸螢幕空間那條路管。
   */
  resolution?: number;
  /**
   * 外擴多少（佔外接盒的比例）。預設 0.25。
   *
   * 場要比物體大一圈，否則貼著表面往外走的光線立刻就出界了 —— 而出界之後
   * 沒有資料可查，只能當成「什麼都沒有」。那會讓緊貼物體的地方少掉遮蔽。
   */
  padding?: number;
}

export interface DistanceField {
  /** 每一格到最近表面的距離，世界單位。裡面是負的。 */
  data: Float32Array;
  resolution: number;
  /** 場的最小角與邊長，世界座標。 */
  min: [number, number, number];
  size: [number, number, number];
}

/**
 * 從三角形烘一個距離場。
 *
 * 做法分兩步，兩步都是為了**不要對每一格掃過所有三角形**（那是 O(格 × 三角形)，
 * 32³ 配一萬個三角形就是三億次）：
 *
 * 1. 標出三角形碰到的格子，順便算那些格子的距離
 * 2. 從那些格子往外**逐層擴散**，每一層取鄰居的距離加一格
 *
 * 第二步是 chamfer 距離變換的簡化版：它給出的不是精確的歐氏距離，而是稍微
 * 偏大的近似。偏大的方向是安全的 —— 光線會多走一點，最多是少擋一點光，
 * 不會穿過東西。
 */
export function bakeDistanceField(
  positions: ArrayLike<number>,
  indices: ArrayLike<number> | null,
  options: DistanceFieldOptions = {},
): DistanceField {
  const n = Math.max(8, Math.floor(options.resolution ?? 32));
  const padding = options.padding ?? 0.25;
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
  const padX = spanX * padding;
  const padY = spanY * padding;
  const padZ = spanZ * padding;
  const originX = minX - padX;
  const originY = minY - padY;
  const originZ = minZ - padZ;
  const sizeX = spanX + padX * 2;
  const sizeY = spanY + padY * 2;
  const sizeZ = spanZ + padZ * 2;

  const cellX = sizeX / n;
  const cellY = sizeY / n;
  const cellZ = sizeZ / n;
  // 一格的對角線 —— 逐層擴散每走一層就加這麼多。
  const step = Math.sqrt(cellX * cellX + cellY * cellY + cellZ * cellZ);

  const total = n * n * n;
  const data = new Float32Array(total).fill(Infinity);
  const surface = new Uint8Array(total);
  const at = (x: number, y: number, z: number): number => (z * n + y) * n + x;

  // ## 1. 三角形碰到的格子
  //
  // 用三角形的外接盒標，不做精確相交。標多了只是讓距離場保守一點（東西看
  // 起來胖一點），而那個方向是安全的：多擋一點光不會穿幫，少擋會漏光。
  for (let t = 0; t < triangleCount; t++) {
    let tx0 = Infinity;
    let ty0 = Infinity;
    let tz0 = Infinity;
    let tx1 = -Infinity;
    let ty1 = -Infinity;
    let tz1 = -Infinity;
    for (let v = 0; v < 3; v++) {
      const index = indices !== null ? indices[t * 3 + v]! : t * 3 + v;
      const x = positions[index * 3]!;
      const y = positions[index * 3 + 1]!;
      const z = positions[index * 3 + 2]!;
      if (x < tx0) tx0 = x;
      if (x > tx1) tx1 = x;
      if (y < ty0) ty0 = y;
      if (y > ty1) ty1 = y;
      if (z < tz0) tz0 = z;
      if (z > tz1) tz1 = z;
    }
    const gx0 = clamp(Math.floor((tx0 - originX) / cellX), n);
    const gx1 = clamp(Math.floor((tx1 - originX) / cellX), n);
    const gy0 = clamp(Math.floor((ty0 - originY) / cellY), n);
    const gy1 = clamp(Math.floor((ty1 - originY) / cellY), n);
    const gz0 = clamp(Math.floor((tz0 - originZ) / cellZ), n);
    const gz1 = clamp(Math.floor((tz1 - originZ) / cellZ), n);
    for (let z = gz0; z <= gz1; z++) {
      for (let y = gy0; y <= gy1; y++) {
        for (let x = gx0; x <= gx1; x++) {
          const index = at(x, y, z);
          surface[index] = 1;
          data[index] = 0;
        }
      }
    }
  }

  // ## 2. 從表面往外逐層擴散
  //
  // 每一層的距離是上一層加一格。這是 chamfer 距離的簡化版 —— 對角線方向會
  // 稍微偏大，而偏大代表光線走得比實際能走的遠一點點，最多少擋一點光。
  let frontier: number[] = [];
  for (let i = 0; i < total; i++) if (surface[i] === 1) frontier.push(i);

  let distance = 0;
  while (frontier.length > 0) {
    distance += step;
    const next: number[] = [];
    for (const index of frontier) {
      const x = index % n;
      const y = ((index / n) | 0) % n;
      const z = (index / (n * n)) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            const nz = z + dz;
            if (nx < 0 || ny < 0 || nz < 0 || nx >= n || ny >= n || nz >= n) continue;
            const ni = at(nx, ny, nz);
            if (data[ni]! !== Infinity) continue;
            data[ni] = distance;
            next.push(ni);
          }
        }
      }
    }
    frontier = next;
  }

  // 沒被碰到的（幾何是空的）填一個大值 —— 不能留 Infinity，那個上不了貼圖。
  const far = Math.max(sizeX, sizeY, sizeZ);
  for (let i = 0; i < total; i++) if (data[i] === Infinity) data[i] = far;

  // ## 3. 內部標成負的
  //
  // 從邊界灌水，灌不到的就是裡面。與 `innerBox` 同一個判準，理由也一樣：
  // 破面的模型水會漏進去，於是「裡面」是空的 —— 而那只是讓場退化成無號的，
  // 光線照樣擋得住，只是貼著表面時少了一點準度。安全的失敗方向。
  markInside(data, n, surface);

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

/** 從邊界灌水；灌不到又不是表面的格子就是內部，距離取負。 */
function markInside(data: Float32Array, n: number, surface: Uint8Array): void {
  const total = n * n * n;
  const outside = new Uint8Array(total);
  const at = (x: number, y: number, z: number): number => (z * n + y) * n + x;
  const stack: number[] = [];

  const push = (x: number, y: number, z: number): void => {
    if (x < 0 || y < 0 || z < 0 || x >= n || y >= n || z >= n) return;
    const index = at(x, y, z);
    if (outside[index] === 1 || surface[index] === 1) return;
    outside[index] = 1;
    stack.push(index);
  };

  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (x === 0 || y === 0 || z === 0 || x === n - 1 || y === n - 1 || z === n - 1) push(x, y, z);
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

  for (let i = 0; i < total; i++) {
    if (outside[i] === 0 && surface[i] === 0) data[i] = -data[i]!;
  }
}
