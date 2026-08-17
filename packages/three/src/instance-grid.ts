import { CellVisibility } from '@ww/engine';
import type { Frustum } from './camera-frustum.ts';

/** 4×4 矩陣某一欄（3 個分量）的長度平方。開根號留到最後才做一次。 */
function sqLength(m: Float32Array, at: number): number {
  const x = m[at]!;
  const y = m[at + 1]!;
  const z = m[at + 2]!;
  return x * x + y * y + z * z;
}

/**
 * 一組 instance 矩陣上的均勻空間格。
 *
 * ## 它解決的問題
 *
 * `THREE.BatchedMesh` 的逐 instance 剔除是對的，但它每幀走訪**全部**
 * instance：讀 4×4 矩陣、把包圍球轉到世界空間、測六個平面。10 萬個
 * instance 就是 10 萬次，不管相機看向哪裡。
 *
 * 空間格把它倒過來：先測幾百個 cell 的 AABB，看不見的 cell 連走訪都不必。
 * 開放世界相機（貼地、看向地平線、內容大多在身後）的剔除率通常是 80%
 * 以上，那 80% 原本是**純粹的白工**。
 *
 * ## 為什麼是 instance 的順序表，而不是重排矩陣
 *
 * 使用者拿 `setMatrixAt(i, …)` 的 `i` 當自己的索引 —— 它必須永遠指向
 * 同一個 instance。重排矩陣會讓 `getMatrixAt(i)` 回傳別人的東西，而那個
 * 錯誤不會報錯，只會讓使用者的邏輯對到錯的物件上。
 *
 * 所以矩陣原地不動，另外維護一張依 cell 排序的 id 表。`BatchedMesh` 的
 * indirect texture 本來就允許任意繪製順序，所以這不需要任何額外上傳。
 */
export class InstanceGrid {
  /** 依 cell 排序的 instance id。`visibleRanges` 的 [start, end) 指向這裡。 */
  private _order = new Uint32Array(0);
  private cellSize = 1;
  private visibility: CellVisibility | null = null;
  private _cellCount = 0;
  private _cellRanges = new Int32Array(0);
  private dirty = true;
  /**
   * 重建時的暫存，**跨重建重用**。
   *
   * 每次 `new Uint32Array(count)` 在串流下就是每幀配置一份幾十萬位元組。
   * 這三個的大小都只跟 instance 數與 cell 數有關，所以留著重用就好。
   */
  private slots = new Uint32Array(0);
  private cursors = new Int32Array(0);
  private ranges = new Int32Array(0);

  get order(): Uint32Array {
    return this._order;
  }

  get cellCount(): number {
    return this._cellCount;
  }

  /**
   * 每一格在 `order` 裡的 `[start, end)`，一格兩個值。
   *
   * HLOD 用它決定「一整格烘成一份幾何」的邊界。沒建過格時是空的。
   */
  get cellRanges(): Int32Array {
    return this._cellRanges;
  }

  /** 目前這一幀通過 AABB 測試的 cell 數。沒建過格回傳 0。 */
  get visibleCells(): number {
    return this.visibility?.visibleCells ?? 0;
  }

  /**
   * 標記格子過期。矩陣一改就要呼叫。
   *
   * 重建是 O(n log n)（排序），所以**每幀都改矩陣的內容不該用空間格** ——
   * 那種內容的正確作法是逐 instance 測試。目前的判斷是：靜態放置是絕大
   * 多數（森林、城市、碎石），動態的通常數量小。
   */
  invalidate(): void {
    this.dirty = true;
  }

  get needsRebuild(): boolean {
    return this.dirty;
  }

  /**
   * 依 instance 的世界位置重建空間格。
   *
   * @param matrices 連續排列的 4×4 矩陣（column-major，與 Three.js 相同）。
   * @param count instance 數。
   * @param baseRadius 單一 instance 在**未縮放**時的包圍球半徑（已含球心
   *   相對原點的偏移）。這裡會乘上實際的最大縮放才拿去外擴 cell。
   *
   *   **這個外擴不是保險，是正確性的必要條件**：instance 是依中心點分配到
   *   cell 的，所以體積一定會突出格線。不外擴就會把突出的部分連同整個
   *   cell 一起剔掉 —— 而症狀是畫面偶爾破洞，所有時間指標完全正常。
   *   同樣的錯誤在引擎那一側犯過三次。
   * @param targetPerCell 每個 cell 的目標 instance 數。cell 切得越細剔除率
   *   越高，但 cell 本身的測試次數也越多；這個值決定兩者的平衡點。
   */
  rebuild(matrices: Float32Array, count: number, baseRadius: number, targetPerCell = 64): void {
    this.dirty = false;
    if (count === 0) {
      this._cellCount = 0;
      this._cellRanges = new Int32Array(0);
      this.visibility = null;
      return;
    }

    // 先量內容的實際範圍。cellSize 用猜的會在兩個方向上都出錯：
    // 太大則整個世界只有一個 cell（等於沒做），太小則 cell 數量爆炸。
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    // 同一趟順便量最大縮放。分兩趟只是多走一次記憶體，而漏掉縮放的後果
    // 是外擴不足 —— 那是會看見的破洞。
    let maxScaleSq = 0;
    for (let i = 0; i < count; i++) {
      const base = i * 16;
      const x = matrices[base + 12]!;
      const y = matrices[base + 13]!;
      const z = matrices[base + 14]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;

      const c0 = sqLength(matrices, base);
      const c1 = sqLength(matrices, base + 4);
      const c2 = sqLength(matrices, base + 8);
      const largest = c0 > c1 ? (c0 > c2 ? c0 : c2) : c1 > c2 ? c1 : c2;
      if (largest > maxScaleSq) maxScaleSq = largest;
    }
    const radius = baseRadius * Math.sqrt(maxScaleSq);

    const spanX = Math.max(maxX - minX, 1e-3);
    const spanZ = Math.max(maxZ - minZ, 1e-3);
    // 目標 cell 數 = count / targetPerCell，攤在 XZ 兩個方向上。
    const targetCells = Math.max(1, Math.ceil(count / targetPerCell));
    const area = (spanX * spanZ) / targetCells;
    // cell 不該小於物件本身 —— 那只會讓同一個物件的外擴蓋滿好幾個 cell，
    // 測試次數暴增而剔除率不動。
    this.cellSize = Math.max(Math.sqrt(area), radius * 2, 1e-3);

    // `CellVisibility` 的 AABB 是**以 y = 0 為中心**的 ±halfHeight，不是
    // 以內容的中點為中心。所以這裡要取絕對值的最大者：內容整片浮在
    // y = 1000 的話，用「高度的一半」會讓每一個 cell 都被剔掉。
    const halfHeight = Math.max(Math.abs(minY), Math.abs(maxY)) + radius + 1e-3;
    // capacity 只是初始值，CellVisibility 會自己長大；給準一點少幾次搬移。
    const gridX = Math.ceil(spanX / this.cellSize) + 1;
    const gridZ = Math.ceil(spanZ / this.cellSize) + 1;
    const visibility = new CellVisibility(
      this.cellSize,
      halfHeight,
      radius,
      Math.min(gridX * gridZ + 2, 1 << 16),
    );

    // ## 依 cell 分組是**計數排序**，不是比較排序
    //
    // 要的不是一個全序，是「同一個 cell 的 id 連續」。而 cell 數遠小於
    // instance 數（34,000 個 instance 只有 576 格），所以桶排一趟就夠。
    //
    // 原本用 `order.sort((a, b) => slots[a] - slots[b])`，實測那一行就是
    // 重建成本的四分之三：
    //
    // | instance 數 | 整個重建 | 其中 sort |
    // | ---: | ---: | ---: |
    // | 10,000 | 1.752 ms | 1.159 ms |
    // | 34,000 | 6.047 ms | 4.546 ms |
    // | 160,000 | 33.306 ms | 24.487 ms |
    //
    // 貴的不是排序本身，是**每一次比較都要呼叫一次 JS 函式**（34,000 個
    // 要五十萬次）。計數排序連比較都沒有。
    //
    // 順便也不需要 `Set` 去數有幾格了 —— 計數陣列本來就知道（那是另外
    // 0.471 ms）。
    if (this._order.length < count) this._order = new Uint32Array(count);
    if (this.slots.length < count) this.slots = new Uint32Array(count);
    const order = this._order;
    const slots = this.slots;
    let maxSlot = 0;
    for (let i = 0; i < count; i++) {
      const base = i * 16;
      const slot = visibility.slotAt(matrices[base + 12]!, matrices[base + 14]!);
      slots[i] = slot;
      if (slot > maxSlot) maxSlot = slot;
    }

    // slot 是 `CellVisibility` 從 1 開始密集發的，所以直接當桶的索引用。
    if (this.cursors.length < maxSlot + 2) this.cursors = new Int32Array(maxSlot + 2);
    const cursors = this.cursors;
    cursors.fill(0, 0, maxSlot + 2);
    for (let i = 0; i < count; i++) cursors[slots[i]! + 1]!++;

    let cells = 0;
    let running = 0;
    for (let slot = 1; slot <= maxSlot; slot++) {
      const n = cursors[slot + 1]!;
      if (n > 0) cells++;
      cursors[slot] = running;
      running += n;
    }

    // 順便把每一格的 [start, end) 留下來。HLOD 要以「一整格」為單位烘合併
    // 幾何，而這裡是唯一知道格子邊界在哪的地方。
    if (this.ranges.length < cells * 2) this.ranges = new Int32Array(cells * 2);
    const ranges = this.ranges;
    let at = 0;
    for (let slot = 1; slot <= maxSlot; slot++) {
      const start = cursors[slot]!;
      // 前綴和跑完之後 `cursors[slot + 1]` 就是下一格的起點，也就是這一格的
      // 終點。最後一格沒有下一格，用總數。
      const end = slot === maxSlot ? running : cursors[slot + 1]!;
      if (end === start) continue;
      visibility.setRowRange(slot, start, end);
      ranges[at * 2] = start;
      ranges[at * 2 + 1] = end;
      at++;
    }

    // 放進去。同一格內 id 保持遞增 —— 走訪順序與矩陣的排列順序一致，
    // 那是包圍球快取的區域性所依賴的性質（見 `ensureSpheres`）。
    for (let i = 0; i < count; i++) order[cursors[slots[i]!]!++] = i;

    this.visibility = visibility;
    this._cellCount = cells;
    this._cellRanges = ranges.subarray(0, cells * 2);
  }

  /**
   * 依這一幀的視錐更新可見 cell，回傳要走訪的 `order` 區段。
   *
   * 沒建過格時回傳 `count === 0`，呼叫端**必須**退回完整走訪 —— 空的
   * 範圍表與「什麼都看不見」在型別上長得一模一樣，而選錯方向的後果是
   * 整批內容消失。
   */
  update(
    frustum: Frustum,
    cameraX: number,
    cameraY: number,
    cameraZ: number,
  ): { bounds: Int32Array; count: number } | null {
    const visibility = this.visibility;
    if (visibility === null) return null;
    visibility.update(frustum, cameraX, cameraY, cameraZ);
    const ranges = visibility.visibleRanges;
    return ranges.count > 0 || visibility.visibleCells === 0 ? ranges : null;
  }
}
