import { VERTEX_FLOATS, type Bounds, maxSurfaceDeviation } from '@webworld/format';
import { MeshoptEncoder } from 'meshoptimizer/encoder';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { generateTangents as generateMikkTangents } from 'mikktspace';

/**
 * 幾何處理階段。
 *
 * 全部在 cook 時完成。Runtime 只負責把處理好的 buffer 丟給 GPU ——
 * 「很多事情不是 runtime 做，而是在 build 時完成」是資產管線存在的理由。
 */

export interface RawMesh {
  /** 交錯排列：position(3) + normal(3) + uv(2) + tangent(4)。 */
  vertices: Float32Array;
  indices: Uint32Array;
  /**
   * 來源是否**自己帶了**法線。
   *
   * 帶了就不重算。美術會刻意用自訂法線做出硬邊、圓角著色、或讓一叢草的
   * 法線全部朝上 —— 重算會把那些意圖全部抹掉，而且抹掉之後看起來「也很正常」，
   * 只是不是他們要的樣子。
   */
  hasNormals?: boolean;
  /**
   * 來源是否**自己帶了**切線。
   *
   * 帶了就不重算。glTF 規格明說 TANGENT 存在時應該使用它 —— 那組切線是
   * 與該資產的法線貼圖配套烘焙出來的，換一組就等於換了基底。
   */
  hasTangents?: boolean;
}

export function vertexCount(mesh: RawMesh): number {
  return mesh.vertices.length / VERTEX_FLOATS;
}

export function triangleCount(mesh: RawMesh): number {
  return mesh.indices.length / 3;
}

/**
 * 焊接重複頂點。
 *
 * 匯入的網格常常每個三角形都有獨立的頂點（例如 OBJ 或未最佳化的匯出），
 * 不焊接的話 LOD 簡化根本無從進行 —— simplifier 看到的是一堆互不相連的
 * 三角形，找不到可以塌陷的邊。
 *
 * 用位元組層級的鍵值比對而非浮點近似：cook 必須可重現，而「幾乎相等」
 * 的判定會隨浮點誤差在不同機器上得到不同結果。
 */
export function weld(mesh: RawMesh): RawMesh {
  const count = vertexCount(mesh);
  const map = new Map<string, number>();
  const remap = new Uint32Array(count);
  const out: number[] = [];

  for (let v = 0; v < count; v++) {
    const base = v * VERTEX_FLOATS;
    // 直接用數值序列當鍵：精確比對，不做容差
    const key = mesh.vertices.subarray(base, base + VERTEX_FLOATS).join(',');
    const existing = map.get(key);
    if (existing !== undefined) {
      remap[v] = existing;
      continue;
    }
    const index = out.length / VERTEX_FLOATS;
    map.set(key, index);
    remap[v] = index;
    for (let i = 0; i < VERTEX_FLOATS; i++) out.push(mesh.vertices[base + i]!);
  }

  const indices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i++) indices[i] = remap[mesh.indices[i]!]!;

  return { vertices: new Float32Array(out), indices };
}

/**
 * 用 MikkTSpace 產生切線。
 *
 * ## 為什麼用現成的
 *
 * 這是少數「一定要用參考實作」的地方。法線貼圖的每個像素都是相對於某個
 * 切線基底的方向，而 Blender / Substance / Marmoset 烘焙時用的都是
 * MikkTSpace。自己寫一套「數學上也對」的切線累加會得到**不同的基底**，
 * 於是每一張外部烘焙的法線貼圖都會有微妙的偏差 —— 畫面不會壞，只是
 * 「看起來就是差一點」，而且幾乎不可能歸因到切線上。
 *
 * `mikktspace` 是 WASM 版的參考實作。它符合我們對相依的標準：WASM 隨
 * npm 套件一起下載，跨平台、無原生建置步驟（這正是 `toktx` 過不了的那一關）。
 *
 * ## 為什麼要先拆開再焊回去
 *
 * MikkTSpace 的介面吃**未索引**的三角形串流，而且這是必要的而非介面缺陷：
 * 它會在 UV 接縫兩側刻意產生**不同**的切線。若先焊接再算，接縫處的頂點
 * 已經被合併，接縫就會出現一條可見的光照裂縫。
 *
 * 因此順序是「拆開 → 算切線 → 重新焊接」。重新焊接時 `weld` 的鍵值涵蓋
 * 整個頂點（含切線），所以接縫兩側會**正確地保持分離**，其餘則合併回去。
 */
export function generateTangents(mesh: RawMesh): RawMesh {
  const triangles = triangleCount(mesh);
  if (triangles === 0) return mesh;

  const position = new Float32Array(triangles * 9);
  const normal = new Float32Array(triangles * 9);
  const texcoord = new Float32Array(triangles * 6);

  for (let i = 0; i < triangles * 3; i++) {
    const src = mesh.indices[i]! * VERTEX_FLOATS;
    position[i * 3] = mesh.vertices[src]!;
    position[i * 3 + 1] = mesh.vertices[src + 1]!;
    position[i * 3 + 2] = mesh.vertices[src + 2]!;
    normal[i * 3] = mesh.vertices[src + 3]!;
    normal[i * 3 + 1] = mesh.vertices[src + 4]!;
    normal[i * 3 + 2] = mesh.vertices[src + 5]!;
    texcoord[i * 2] = mesh.vertices[src + 6]!;
    texcoord[i * 2 + 1] = mesh.vertices[src + 7]!;
  }

  const tangents = generateMikkTangents(position, normal, texcoord);

  // 攤平成未索引的頂點，切線寫進去，再由呼叫端焊接回來
  const vertices = new Float32Array(triangles * 3 * VERTEX_FLOATS);
  for (let i = 0; i < triangles * 3; i++) {
    const src = mesh.indices[i]! * VERTEX_FLOATS;
    const dst = i * VERTEX_FLOATS;
    for (let f = 0; f < 8; f++) vertices[dst + f] = mesh.vertices[src + f]!;
    vertices[dst + 8] = tangents[i * 4]!;
    vertices[dst + 9] = tangents[i * 4 + 1]!;
    vertices[dst + 10] = tangents[i * 4 + 2]!;
    vertices[dst + 11] = tangents[i * 4 + 3]!;
  }

  const indices = new Uint32Array(triangles * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;

  return weld({ vertices, indices });
}

/** 抽出 simplifier 需要的、緊密排列的位置陣列。 */
function extractPositions(mesh: RawMesh): Float32Array {
  const count = vertexCount(mesh);
  const positions = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const src = v * VERTEX_FLOATS;
    positions[v * 3] = mesh.vertices[src]!;
    positions[v * 3 + 1] = mesh.vertices[src + 1]!;
    positions[v * 3 + 2] = mesh.vertices[src + 2]!;
  }
  return positions;
}

export function computeBounds(mesh: RawMesh): Bounds {
  const count = vertexCount(mesh);
  if (count === 0) {
    return { center: [0, 0, 0], radius: 0, min: [0, 0, 0], max: [0, 0, 0] };
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let v = 0; v < count; v++) {
    const base = v * VERTEX_FLOATS;
    const x = mesh.vertices[base]!;
    const y = mesh.vertices[base + 1]!;
    const z = mesh.vertices[base + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  const center: [number, number, number] = [
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2,
  ];

  // 用實際最遠頂點求半徑，而不是 AABB 對角線的一半 —— 後者對細長物件
  // 會高估很多，直接影響 culling 的保守程度。
  let radiusSq = 0;
  for (let v = 0; v < count; v++) {
    const base = v * VERTEX_FLOATS;
    const dx = mesh.vertices[base]! - center[0];
    const dy = mesh.vertices[base + 1]! - center[1];
    const dz = mesh.vertices[base + 2]! - center[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d > radiusSq) radiusSq = d;
  }

  return {
    center,
    radius: Math.sqrt(radiusSq),
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };
}

export interface LodResult {
  mesh: RawMesh;
  /** 世界單位的簡化誤差。 */
  error: number;
}

export interface LodOptions {
  /** 每一階相對於前一階保留的三角形比例。 */
  ratios: readonly number[];
  /** 相對誤差上限；超過就停止產生更粗的 LOD。 */
  maxRelativeError: number;
}

/**
 * LOD 鏈的預設設定。
 *
 * ## 為什麼誤差上限可以放到 0.2
 *
 * 直覺上「20% 幾何誤差」聽起來很粗糙，但 LOD **選擇**是依螢幕空間誤差的：
 * 只有當該階的誤差投影到螢幕上 ≤ `errorPixels`（預設 2 像素）時才會被選用。
 * 所以加入誤差更大的階**不會降低畫質** —— 它在近處根本不會被選中。
 *
 * 上限訂太低反而是白白留下效能。實測顯示可見物件有 83%
 * 只佔 8–32 像素，卻仍在畫 334 個三角形 —— 三角形比像素還多。GPU 以
 * 2×2 quad 光柵化，次像素三角形至少浪費 4 倍。
 *
 * 餘裕算得出來：16 像素大小的物件約在 580 世界單位處，2 像素的誤差預算
 * 對應 1.25 世界單位；而 0.05 的上限在該尺度只用掉 0.5。
 *
 * ## 為什麼還是有上限
 *
 * 不設上限的話，簡化器會一路把網格塌陷到失去形狀。那些階仍然「合法」
 * （選擇器不會在近處用它們），但會佔用檔案空間與載入時間，而且極遠處
 * 真正該用的是 impostor而不是 20 個三角形的爛網格。
 */
export const DEFAULT_LOD_OPTIONS: LodOptions = {
  ratios: [0.5, 0.5, 0.4, 0.4, 0.4, 0.4],
  maxRelativeError: 0.2,
};

/**
 * 產生 LOD 鏈。
 *
 * 索引被簡化，**頂點陣列保持不變** —— 所有 LOD 共用同一份頂點資料。
 * 這是 meshoptimizer 的設計：簡化只是移除索引對某些頂點的參照。好處是
 * 切換 LOD 不需要重新上傳頂點，只要換 index buffer。
 *
 * 誤差以**世界單位**回報（simplifier 回傳的是相對值，乘上 `getScale`）。
 * LOD 選擇要看的是誤差投影到螢幕上的像素數，相對值無法做這個計算。
 */
export async function generateLods(
  mesh: RawMesh,
  options: LodOptions = DEFAULT_LOD_OPTIONS,
): Promise<LodResult[]> {
  await MeshoptSimplifier.ready;

  const positions = extractPositions(mesh);
  const lods: LodResult[] = [{ mesh, error: 0 }];

  let previousLength = mesh.indices.length;
  let fraction = 1;
  for (const ratio of options.ratios) {
    fraction *= ratio;
    const targetIndexCount = Math.floor((mesh.indices.length * fraction) / 3) * 3;
    // 少於一個三角形就沒有意義了
    if (targetIndexCount < 3) break;

    // **每一階都從 LOD0 簡化，不是從上一階。**
    //
    // `simplify()` 回傳的誤差是「相對於傳進去的那個網格」。串接著簡化的話，
    // 第 2 階拿到的是「相對第 1 階」的增量誤差 —— 而選階要的是**相對
    // LOD0**，因為品質契約講的是「跟原始幾何差幾個像素」。
    //
    // 差多少是量過的，不是推的。icosphere(3) 上串接與從 LOD0 相比：
    //
    // ```text
    // 階      1        2        3        4        5        6
    // 串接    0.0155   0.0247   0.0555   0.1554   0.2697   0.3983
    // LOD0    0.0155   0.0259   0.0681   0.1546   0.2995   0.3183
    // ```
    //
    // 最大差 23%（第 3 階），方向是**低估** —— 也就是在太近的距離挑到
    // 太粗的階。不是災難級，但它是白白讓出去的品質保證，而且沒有任何
    // 東西會報錯。
    //
    // 代價是簡化器多走幾趟完整網格。這是 cook 時做的事，不進 runtime。
    // 第二個回傳值是 simplifier 自己估的誤差。**刻意不用** —— 見下面。
    const [simplified] = MeshoptSimplifier.simplify(
      mesh.indices,
      positions,
      3,
      targetIndexCount,
      options.maxRelativeError,
    );

    // simplifier 達不到目標時會回傳原本的索引；再往下產生只是浪費空間
    if (simplified.length >= previousLength) break;

    // 塌成幾乎沒有三角形的階會在夠遠的距離被選中，然後**整個物件消失** ——
    // 沒有錯誤、沒有警告。少於 4 個面圍不出體積。
    if (simplified.length < 4 * 3) break;

    previousLength = simplified.length;

    const lod: LodResult = {
      mesh: { vertices: mesh.vertices, indices: simplified },
      // ## 誤差是量出來的，不是 `relativeError * scale`
      //
      // 那個是 meshoptimizer 的**估計值，不是上界**。拿有封閉解的幾何比對過
      // （icosphere，真值用矢高）：每一階都低估，最多 1.48 倍。於是實際的
      // 契約變成「≤ 大約 3 像素」而不是宣稱的 2 像素，而沒有任何東西會報錯。
      //
      // 量法住在 `@webworld/format` —— **這個數字的定義本身就是格式契約的
      // 一部分**，cook 這邊寫進 `.wwm`、runtime 那邊讀出來選階，兩邊對它的
      // 意思必須一模一樣。只修一邊的症狀是「cook 過的資產比 runtime 產生的
      // 糊」，而型別檢查不會有意見。
      error: maxSurfaceDeviation(positions, {
        positions,
        indices: Uint32Array.from(simplified),
      }),
    };

    // **丟掉被支配的階。** 簡化器對每個目標三角形數各做一次貪婪選擇，
    // 誤差不保證隨階數遞增 —— 實測球體會出現「更粗但更準」的階，那代表
    // 前一階同時比它多三角形又比它不準，留著只是佔檔案空間。
    //
    // 選階本身不會因此出錯（它挑的是誤差夠小的最粗一階），但「更粗 =
    // 更不準」是所有下游都在假設的性質，讓它不成立遲早會咬人。
    const last = lods.at(-1)!;
    if (lods.length > 1 && lod.error <= last.error) lods[lods.length - 1] = lod;
    else lods.push(lod);
  }

  return lods;
}

/**
 * 為 GPU 重排 LOD 鏈：頂點快取與頂點抓取最佳化。
 *
 * ## 為什麼這是 cooker 該做的事
 *
 * 這是**零畫質成本、零 runtime 成本**的純賺：幾何完全不變，只改頂點在
 * 記憶體裡的順序與三角形被送出的順序。GPU 有一個 post-transform 頂點快取，
 * 重複用到的頂點若還在快取裡就不必重跑 vertex shader。
 *
 * 實測顯示這類內容是**三角形吞吐受限**（把像素數砍到 1/4，GPU 時間
 * 只降 4.5%；而三角形吞吐在 24 倍的三角形數範圍內是常數 394–427M/s）。
 * 頂點端的任何節省都直接反映在幀時間上。
 *
 * ## 共用頂點的陷阱
 *
 * `reorderMesh` 同時做兩件事：重排索引順序（快取）與重排頂點順序（抓取）。
 * 但**所有 LOD 共用同一份頂點資料**，所以不能對每個 LOD 各跑一次 ——
 * 那會產生三份互不相容的頂點順序。
 *
 * 做法分兩步：
 *
 * 1. 用 **LOD0** 決定共用的頂點順序，並把 remap 套用到**每一個** LOD 的索引
 * 2. 對 LOD1 以後**只重排三角形順序**（不動頂點），用「跑一次 reorderMesh
 *    再用 remap 的反向對應把編號換回來」達成
 *
 * 第 2 步是必要的：實際畫最多的是粗 LOD（27,463 個 instance 用的是最後幾階），
 * 只最佳化 LOD0 等於最佳化了最少被畫的那一階。
 *
 * ## 誠實的限制
 *
 * 粗 LOD 只參照頂點緩衝區裡稀疏的一小部分，所以它們的**抓取**順序天生就是
 * 分散的 —— 這是「所有 LOD 共用頂點」這個設計的固有代價。第 2 步能救的是
 * 快取命中，救不了抓取局部性。真正的解法是 meshlet，屆時每個
 * cluster 自帶緊密的頂點子集。
 */
export async function optimizeLodChain(lods: LodResult[]): Promise<LodResult[]> {
  await MeshoptEncoder.ready;
  const first = lods[0];
  if (first === undefined) return lods;

  const vertices = first.mesh.vertices;
  const count = vertexCount(first.mesh);

  // ── 第 1 步：用 LOD0 決定共用的頂點順序 ──
  const lod0Indices = new Uint32Array(first.mesh.indices);
  const [remap] = MeshoptEncoder.reorderMesh(lod0Indices, true, false);

  const reordered = new Float32Array(vertices.length);
  for (let v = 0; v < count; v++) {
    const dst = remap[v]! * VERTEX_FLOATS;
    const src = v * VERTEX_FLOATS;
    for (let f = 0; f < VERTEX_FLOATS; f++) reordered[dst + f] = vertices[src + f]!;
  }

  const out: LodResult[] = [];
  for (const [level, lod] of lods.entries()) {
    if (level === 0) {
      out.push({ mesh: { vertices: reordered, indices: lod0Indices }, error: lod.error });
      continue;
    }

    // remap 套用到這一階的索引，讓它指向新的頂點順序
    const remapped = new Uint32Array(lod.mesh.indices.length);
    for (let i = 0; i < remapped.length; i++) remapped[i] = remap[lod.mesh.indices[i]!]!;

    // ── 第 2 步：只重排三角形順序，不動頂點 ──
    // reorderMesh 會給出這一階自己的最佳頂點編號，但我們不能採用它
    // （頂點是共用的）。所以跑完之後用反向對應把編號換回共用編號 ——
    // 保留最佳化過的三角形順序，捨棄它的頂點順序。
    const scratch = new Uint32Array(remapped);
    const [localRemap, unique] = MeshoptEncoder.reorderMesh(scratch, true, false);
    const inverse = new Uint32Array(unique);
    for (let v = 0; v < count; v++) {
      const local = localRemap[v]!;
      if (local < unique) inverse[local] = v;
    }
    for (let i = 0; i < scratch.length; i++) remapped[i] = inverse[scratch[i]!]!;

    out.push({ mesh: { vertices: reordered, indices: remapped }, error: lod.error });
  }
  return out;
}

/**
 * 產生碰撞用的簡化網格。
 *
 * 碰撞不需要視覺細節，但**必須保守**：太細會拖慢物理，太粗會讓角色穿牆。
 * 這裡用比視覺 LOD 更激進的簡化，並鎖住邊界（`LockBorder`）避免開放邊緣
 * 被塌陷成破洞 —— 破洞在物理裡就是穿模。
 *
 * 真正的凸包分解（V-HACD 之類）留待接上物理引擎時再評估。
 */
export async function generateCollision(
  mesh: RawMesh,
  targetRatio = 0.15,
): Promise<RawMesh> {
  await MeshoptSimplifier.ready;

  const positions = extractPositions(mesh);
  const targetIndexCount = Math.max(3, Math.floor((mesh.indices.length * targetRatio) / 3) * 3);

  const [simplified] = MeshoptSimplifier.simplify(
    mesh.indices,
    positions,
    3,
    targetIndexCount,
    0.2,
    ['LockBorder'],
  );

  return { vertices: mesh.vertices, indices: simplified };
}

/**
 * 重新計算平滑法線。
 *
 * 匯入的資料未必有法線，有的也未必正確。以面積加權累加各面法線 ——
 * 面積加權比單純平均更能反映真實曲面，尤其在三角形大小差異大的網格上。
 */
export function recomputeNormals(mesh: RawMesh): RawMesh {
  const count = vertexCount(mesh);
  const normals = new Float32Array(count * 3);

  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i]! * VERTEX_FLOATS;
    const b = mesh.indices[i + 1]! * VERTEX_FLOATS;
    const c = mesh.indices[i + 2]! * VERTEX_FLOATS;

    const ax = mesh.vertices[a]!;
    const ay = mesh.vertices[a + 1]!;
    const az = mesh.vertices[a + 2]!;
    const e1x = mesh.vertices[b]! - ax;
    const e1y = mesh.vertices[b + 1]! - ay;
    const e1z = mesh.vertices[b + 2]! - az;
    const e2x = mesh.vertices[c]! - ax;
    const e2y = mesh.vertices[c + 1]! - ay;
    const e2z = mesh.vertices[c + 2]! - az;

    // 未正規化的叉積長度正比於面積，直接累加即得面積加權
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    for (let corner = 0; corner < 3; corner++) {
      const index = mesh.indices[i + corner]! * 3;
      normals[index] = normals[index]! + nx;
      normals[index + 1] = normals[index + 1]! + ny;
      normals[index + 2] = normals[index + 2]! + nz;
    }
  }

  const vertices = new Float32Array(mesh.vertices);
  for (let v = 0; v < count; v++) {
    const nx = normals[v * 3]!;
    const ny = normals[v * 3 + 1]!;
    const nz = normals[v * 3 + 2]!;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const base = v * VERTEX_FLOATS + 3;
    if (length > 0) {
      vertices[base] = nx / length;
      vertices[base + 1] = ny / length;
      vertices[base + 2] = nz / length;
    } else {
      // 退化三角形產生零長度法線；給一個確定的方向而非 NaN
      vertices[base] = 0;
      vertices[base + 1] = 1;
      vertices[base + 2] = 0;
    }
  }

  return { vertices, indices: mesh.indices };
}
