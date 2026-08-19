/**
 * 把一份很大的幾何切成空間上的小塊。
 *
 * ## 它補的洞
 *
 * `MultiMesh` 已經量過了：420 萬個三角形的地形，整片一份幾何 11.6 ms，切成
 * 32×32 之後 5.25 ms（省 54.7%），而且繪製次數釘在 3。
 *
 * 但那個類別要求呼叫端**自己把 N 份相異的幾何準備好**。地形是自己生的、
 * 本來就一塊一塊，所以沒問題；而「我有一棟掃描回來的建築 / 一整塊城市 /
 * 一份很大的 GLB」的人只有一份幾何，就用不上它。
 *
 * 那正是 [ADR-0001](../../../specs/adr/0001-three-as-adapter.md) 說「Three
 * 沒有、要我們自己建」的那一項：**幾何虛擬化**。這個檔案是它的第一塊 ——
 * 把一份大幾何變成 `MultiMesh` 吃得下的形狀。
 *
 * ## 為什麼按三角形的重心切，而不是按頂點
 *
 * 按頂點分的話，一個三角形的三個頂點可能落在不同塊裡，那個三角形就沒有歸屬
 * ——要嘛掉了（畫面破洞），要嘛被複製到好幾塊（重疊、Z-fighting）。
 *
 * 按重心分則是一個**精確的劃分**：每個三角形剛好屬於一塊，不多不少。邊界上
 * 的頂點會被複製到相鄰的塊裡（同樣的座標），那是必要的，也不會造成破洞。
 *
 * ## 邊界頂點與裂縫
 *
 * 切完之後每一塊各自簡化的話，**相鄰兩塊的共用邊會裂開** —— 兩邊各自把那條
 * 邊簡化成不同的樣子，中間就露出縫。那是這種做法最典型的災難，而且它只在
 * 某些角度看得到。
 *
 * 解法是簡化時鎖住邊界（meshoptimizer 的 `LockBorder`）。這個檔案只負責切，
 * 但**切出來的塊必須讓那件事做得到** —— 也就是邊界頂點要原封不動地留著，
 * 不能在這裡就先合併或搬動。
 */

export interface SplitOptions {
  /**
   * 想切成幾塊。預設 64。
   *
   * 實際數量會接近但通常更少 —— 空的格子不算。內容如果是中空的（建築外殼、
   * 地形表面），大部分格子都是空的。
   *
   * 切多細是個取捨，而 `MultiMesh` 那邊已經量過了：繪製次數是固定的，所以
   * 分越細剔除越準；但每一塊都要付一次選階與包圍球的成本。
   */
  chunks?: number;
  /**
   * 一塊至少要有幾個三角形，低於這個數就併進鄰居。預設 64。
   *
   * 沒有這條的話會生出一堆只有兩三個三角形的碎塊，而每一塊在 `MultiMesh`
   * 裡都是一個 instance —— 碎塊多到一定程度，逐塊的成本會吃掉剔除省下的。
   */
  minTriangles?: number;
}

export interface SplitPiece {
  /** 這一塊的頂點座標，已經重新編號。 */
  positions: Float32Array;
  /** 這一塊的索引，指向上面那份 `positions`。 */
  indices: Uint32Array;
  /**
   * 每個新頂點對應到原本的哪一個頂點。
   *
   * 開出來是為了讓呼叫端把**其他屬性**（法線、UV、切線、顏色）用同一份對應
   * 搬過去 —— 這裡不碰它們，因為每個屬性的分量數與型別都不一樣，在這一層
   * 猜會猜錯。
   */
  sourceVertices: Uint32Array;
}

/**
 * 按三角形重心切成空間上的小塊。
 *
 * @returns 每一塊一份。三角形太少或幾何退化時回傳只有一塊的陣列（就是原本
 *   那一份）—— 切不動的時候不該假裝切了。
 */
export function splitGeometry(
  positions: ArrayLike<number>,
  indices: ArrayLike<number> | null,
  options: SplitOptions = {},
): SplitPiece[] {
  const wanted = Math.max(1, Math.floor(options.chunks ?? 64));
  const minTriangles = Math.max(1, Math.floor(options.minTriangles ?? 64));
  const triangleCount = indices !== null ? Math.floor(indices.length / 3) : Math.floor(positions.length / 9);

  if (wanted <= 1 || triangleCount <= minTriangles) {
    return [wholePiece(positions, indices, triangleCount)];
  }

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
  const sizeX = Math.max(maxX - minX, 1e-9);
  const sizeY = Math.max(maxY - minY, 1e-9);
  const sizeZ = Math.max(maxZ - minZ, 1e-9);

  // ## 格子的形狀跟著外接盒的形狀走，而且**薄的那一軸完全不切**
  //
  // 固定用立方格的話，扁的東西（地形、牆）會在薄的那一軸切出一堆只有一層的
  // 格子。按邊長比例分配才會切出接近立方的塊。
  //
  // 但比例分配對**零厚度**的東西會爆掉：一片平面的 Y 是 0，體積跟著是 0，
  // 開三次方之後格子邊長趨近 0，於是 X 與 Z 各被切成上萬格 —— 每格零個三角形，
  // 全部低於門檻，最後被合併成幾條橫貫整片的長條。切了等於沒切，而三角形
  // 數量那幾條測試照樣會過。
  //
  // 所以先挑出「真的有厚度」的軸，只在那些軸上分配。
  const extents = [sizeX, sizeY, sizeZ];
  const largest = Math.max(sizeX, sizeY, sizeZ);
  const active = extents.map((extent) => extent > largest * 1e-6);
  const activeCount = active.filter(Boolean).length;
  let product = 1;
  for (let axis = 0; axis < 3; axis++) if (active[axis]) product *= extents[axis]!;
  const unit = Math.pow(product / wanted, 1 / Math.max(activeCount, 1));
  const nx = active[0] ? Math.max(1, Math.round(sizeX / unit)) : 1;
  const ny = active[1] ? Math.max(1, Math.round(sizeY / unit)) : 1;
  const nz = active[2] ? Math.max(1, Math.round(sizeZ / unit)) : 1;

  // 每個三角形歸到重心所在的格子。
  const cellOf = new Int32Array(triangleCount);
  const counts = new Int32Array(nx * ny * nz);
  for (let t = 0; t < triangleCount; t++) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let v = 0; v < 3; v++) {
      const index = indices !== null ? indices[t * 3 + v]! : t * 3 + v;
      cx += positions[index * 3]!;
      cy += positions[index * 3 + 1]!;
      cz += positions[index * 3 + 2]!;
    }
    const gx = clampIndex(Math.floor(((cx / 3 - minX) / sizeX) * nx), nx);
    const gy = clampIndex(Math.floor(((cy / 3 - minY) / sizeY) * ny), ny);
    const gz = clampIndex(Math.floor(((cz / 3 - minZ) / sizeZ) * nz), nz);
    const cell = (gz * ny + gy) * nx + gx;
    cellOf[t] = cell;
    counts[cell]!++;
  }

  // ## 太小的格子併到「下一個非空的格子」
  //
  // 併給空間上的鄰居會更好，但那要找鄰居、而且併完可能還是太小，得反覆做。
  // 這裡用線性順序的下一個非空格 —— 而格子的線性順序本來就是 z、y、x 巢狀，
  // 所以「下一個」在空間上通常就在旁邊。
  const remap = new Int32Array(counts.length);
  for (let i = 0; i < remap.length; i++) remap[i] = i;
  let pending = -1;
  let pendingCount = 0;
  for (let cell = 0; cell < counts.length; cell++) {
    if (counts[cell] === 0) continue;
    if (pending >= 0) {
      remap[pending] = cell;
      counts[cell]! += pendingCount;
      pending = -1;
      pendingCount = 0;
    }
    if (counts[cell]! < minTriangles) {
      pending = cell;
      pendingCount = counts[cell]!;
      counts[cell] = 0;
    }
  }
  // 最後一塊沒有下一個可以併，就併回前一個非空的。
  if (pending >= 0) {
    let previous = -1;
    for (let cell = 0; cell < pending; cell++) if (counts[cell]! > 0) previous = cell;
    if (previous >= 0) {
      remap[pending] = previous;
      counts[previous]! += pendingCount;
    } else {
      // 整份幾何都不到門檻 —— 那就不要切。
      return [wholePiece(positions, indices, triangleCount)];
    }
  }

  // 併是可以連鎖的（A 併到 B，B 又併到 C），所以要一路跟到底。
  const resolve = (cell: number): number => {
    let target = cell;
    let guard = 0;
    while (remap[target] !== target && guard++ < remap.length) target = remap[target]!;
    return target;
  };

  const pieceOf = new Map<number, number>();
  const pieceTriangles: number[][] = [];
  for (let t = 0; t < triangleCount; t++) {
    const cell = resolve(cellOf[t]!);
    let piece = pieceOf.get(cell);
    if (piece === undefined) {
      piece = pieceTriangles.length;
      pieceOf.set(cell, piece);
      pieceTriangles.push([]);
    }
    pieceTriangles[piece]!.push(t);
  }

  if (pieceTriangles.length <= 1) return [wholePiece(positions, indices, triangleCount)];

  return pieceTriangles.map((triangles) => buildPiece(positions, indices, triangles));
}

function clampIndex(v: number, n: number): number {
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}

/** 沒切成的時候回傳的那一塊：就是原本的幾何，只是換成這裡的形狀。 */
function wholePiece(
  positions: ArrayLike<number>,
  indices: ArrayLike<number> | null,
  triangleCount: number,
): SplitPiece {
  const triangles: number[] = [];
  for (let t = 0; t < triangleCount; t++) triangles.push(t);
  return buildPiece(positions, indices, triangles);
}

/**
 * 從一組三角形做出一塊，順便把頂點重新編號。
 *
 * 只有這一塊真的用到的頂點會被搬過去 —— 全部搬的話每一塊都帶著整份頂點，
 * 記憶體是原本的 N 倍。
 */
function buildPiece(
  positions: ArrayLike<number>,
  indices: ArrayLike<number> | null,
  triangles: readonly number[],
): SplitPiece {
  const map = new Map<number, number>();
  const sourceVertices: number[] = [];
  const out = new Uint32Array(triangles.length * 3);

  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i]!;
    for (let v = 0; v < 3; v++) {
      const source = indices !== null ? indices[t * 3 + v]! : t * 3 + v;
      let mapped = map.get(source);
      if (mapped === undefined) {
        mapped = sourceVertices.length;
        map.set(source, mapped);
        sourceVertices.push(source);
      }
      out[i * 3 + v] = mapped;
    }
  }

  const piecePositions = new Float32Array(sourceVertices.length * 3);
  for (let i = 0; i < sourceVertices.length; i++) {
    const source = sourceVertices[i]!;
    piecePositions[i * 3] = positions[source * 3]!;
    piecePositions[i * 3 + 1] = positions[source * 3 + 1]!;
    piecePositions[i * 3 + 2] = positions[source * 3 + 2]!;
  }

  return {
    positions: piecePositions,
    indices: out,
    sourceVertices: new Uint32Array(sourceVertices),
  };
}
