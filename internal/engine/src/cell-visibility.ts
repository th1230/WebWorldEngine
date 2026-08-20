import { aabbFrustumRelation, type Frustum } from './frustum.ts';
import { cellKey } from './streaming.ts';

/**
 * Cell 層級的可見性遮罩。
 *
 * ## 為什麼需要它
 *
 * 逐一測試 4 萬個 物件 的視錐是可行的；100 萬個不行。而且逐一測試省下的
 * 只是「畫」的成本 —— **走訪、查表、算距離、選 LOD 這些在發現它不可見
 * 之前就已經付掉了**。
 *
 * 實測開放世界相機的剔除率是 80%：22 萬個物件裡有 17.6 萬個
 * 每個 tick 都被完整處理一遍，只為了在最後一步被丟掉。
 *
 * Cell 遮罩把這件事倒過來：先測 44 個 cell 的 AABB，再讓下游用一次
 * 陣列索引跳過整個 cell 的內容。44 次 AABB 測試換掉 17.6 萬次的白工。
 *
 * ## 為什麼用 slot 而不是 cell 座標
 *
 * 物件 要記住自己屬於哪個 cell。存 (cx, cz) 是兩個 32 bit 欄位，而且
 * 下游還要拿它去查表 —— 又是雜湊。改成「常駐 cell 的槽位編號」：常駐數
 * 有上限（實測 44），u16 一個欄位就夠，下游直接 `mask[slot[row]]`。
 *
 * **槽位 0 保留給「不屬於任何 cell」**，永遠可見。沒有這個保留值的話，
 * 不走串流的 entity（玩家、UI、除錯物件）會被當成 cell 0 的內容一起剔掉。
 */
export class CellVisibility {
  private readonly cellSize: number;
  private readonly halfHeight: number;
  private readonly margin: number;

  private cx: Int32Array;
  private cz: Int32Array;
  private used: Uint8Array;
  private _mask: Uint8Array;
  private readonly free: number[] = [];
  private readonly byKey = new Map<number, number>();
  private highWater = 1;

  private rowStart: Int32Array;
  private rowEnd: Int32Array;
  /**
   * **必須是同一個物件**，不能每次取值都新建。
   *
   * 呼叫端通常在初始化時取一次就交給系統長期持有；回傳快照的話，
   * 系統手上的 count 會永遠停在取值當下的值（初始化時是 0），
   * 於是整個功能靜靜地不生效 —— 而且看起來只是「沒有變快」。
   */
  private readonly _visibleRanges: { bounds: Int32Array; count: number; inside: Uint8Array };
  private hasRanges = false;

  private _visibleCells = 0;
  private _testedCells = 0;

  /**
   * @param cellSize cell 在 XZ 平面的邊長。
   * @param halfHeight cell 內容在 Y 方向的半高，**已含物件本身的尺寸**。
   *   取太小會把高處的物件連同 cell 一起剔掉，那是會看見的破圖。
   * @param margin 單一物件可能突出 cell 邊界的最大距離，即
   *   「最大包圍球半徑 × 最大縮放」。物件 依中心點分配到 cell，
   *   所以它的體積一定會超出格線；不外擴就會剔掉突出的那部分。
   */
  constructor(cellSize: number, halfHeight: number, margin: number, capacity = 64) {
    if (!(cellSize > 0)) throw new Error('cellSize 必須為正數');
    if (!(halfHeight > 0)) throw new Error('halfHeight 必須為正數');
    if (!(margin >= 0)) throw new Error('margin 必須 ≥ 0');
    this.cellSize = cellSize;
    this.halfHeight = halfHeight;
    this.margin = margin;
    const n = Math.max(capacity, 2);
    this.cx = new Int32Array(n);
    this.cz = new Int32Array(n);
    this.used = new Uint8Array(n);
    // 未配置的槽位一律視為可見。遮罩若預設 0，任何忘了配置的路徑都會
    // 靜靜地讓東西消失 —— 那種錯誤比多畫幾個物件難查得多。
    this._mask = new Uint8Array(n).fill(1);
    this.rowStart = new Int32Array(n).fill(-1);
    this.rowEnd = new Int32Array(n);
    this._visibleRanges = { bounds: new Int32Array(n * 2), count: 0, inside: new Uint8Array(n) };
  }

  /** 目前這一幀有幾個 cell 通過測試。 */
  get visibleCells(): number {
    return this._visibleCells;
  }

  get testedCells(): number {
    return this._testedCells;
  }

  /** 下游用它跳過整個 cell：`mask[slot] === 0` 代表不必處理。 */
  get mask(): Uint8Array {
    return this._mask;
  }

  /**
   * 登記一個 cell 佔用的連續列範圍 `[start, end)`。
   *
   * 遮罩讓下游用一次索引跳過一個 entity；**列範圍讓它連走訪都不必**。
   * 實測純走訪（迴圈＋存活檢查＋遮罩查詢）是 20.3 ns/列，在高剔除率下
   * 那是總成本的大半：
   *
   * ```text
   * 剔除率 27%   30.0 → 28.0 ms   1.07x
   * 剔除率 80%   17.6 → 11.2 ms   1.57x
   * ```
   *
   * 所以這只在剔除率高的時候值得 —— 而真實的開放世界相機（貼地、看向
   * 地平線、內容大多在身後）正是那個區間。
   *
   * **呼叫端要負責讓範圍真的連續**：一次生成好、
   * 不卸載的場景，依 cell 排序生成就自然成立；串流場景則需要配置器支援
   * 整塊配置。沒有登記範圍的 cell 一律走完整走訪。
   */
  setRowRange(slot: number, start: number, end: number): void {
    if (slot <= 0 || slot >= this.used.length) return;
    if (!(end > start)) throw new Error(`列範圍 [${start}, ${end}) 無效：end 必須大於 start`);
    this.rowStart[slot] = start;
    this.rowEnd[slot] = end;
    this.hasRanges = true;
  }

  /**
   * 可見 cell 的列範圍，成對排列 `[start0, end0, start1, end1, …]`。
   *
   * 相鄰的範圍會被合併 —— 依 cell 排序生成時，空間上相鄰的 cell 往往
   * 列號也相鄰，合併之後迴圈的外層次數可以少一個數量級。
   *
   * 沒有登記過任何範圍時回傳 `count === 0`，呼叫端應退回完整走訪。
   */
  get visibleRanges(): { bounds: Int32Array; count: number; inside: Uint8Array } {
    return this._visibleRanges;
  }

  /**
   * 為一個常駐 cell 取得槽位。同一個座標重複呼叫回傳同一個槽位。
   *
   * 這裡用 Map 是刻意的：載入與卸載每幀只有個位數次，而熱迴圈碰到的
   * 只有 `mask[slot]` 這個陣列索引。把雜湊留在冷路徑上。
   */
  acquire(cellX: number, cellZ: number): number {
    const key = cellKey(cellX, cellZ);
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;

    const slot = this.free.pop() ?? this.highWater++;
    if (slot >= this.used.length) this.grow(slot + 1);
    this.cx[slot] = cellX;
    this.cz[slot] = cellZ;
    this.used[slot] = 1;
    this._mask[slot] = 1;
    this.rowStart[slot] = -1;
    this.byKey.set(key, slot);
    return slot;
  }

  /**
   * 依世界座標取得槽位，需要時建立新的 cell。
   *
   * 這是給**不走串流**的場景用的：一次生成好的靜態物件（森林、城市的
   * 固定部分、關卡擺放）同樣需要空間劃分，但沒有載入卸載的生命週期。
   *
   * cell 剔除的收益與串流無關 —— 綁在一起的話，任何不用串流的專案
   * 就白白失去它，而那是絕大多數場景的形態。
   */
  slotAt(worldX: number, worldZ: number): number {
    return this.acquire(Math.floor(worldX / this.cellSize), Math.floor(worldZ / this.cellSize));
  }

  release(cellX: number, cellZ: number): void {
    const key = cellKey(cellX, cellZ);
    const slot = this.byKey.get(key);
    if (slot === undefined) return;
    this.byKey.delete(key);
    this.used[slot] = 0;
    // 釋放後保持可見。槽位被重用之前若有殘留的 物件 指著它，
    // 寧可多畫也不要憑空消失。
    this._mask[slot] = 1;
    this.free.push(slot);
  }

  /**
   * 依目前的視錐重算遮罩。
   *
   * 座標是 **camera-relative** 的 —— 與 `Frustum` 一致（見 frustum.ts）。
   * 傳世界座標進來的話，遠原點下 f32 的精度會讓邊界 cell 隨機閃爍。
   */
  update(frustum: Frustum, cameraX: number, cameraY: number, cameraZ: number): void {
    const size = this.cellSize;
    let visible = 0;
    let tested = 0;

    for (let slot = 1; slot < this.highWater; slot++) {
      if (this.used[slot] === 0) continue;
      tested++;
      // 物件 是依**中心點**分配到 cell 的，但它有體積 —— 一個中心落在
      // cell 邊緣的物件，其包圍球會突出到隔壁去。AABB 必須外擴 margin，
      // 否則那些突出的部分會隨著整個 cell 一起被剔掉。
      //
      // cell 遠大於物件時看不出來（串流場景 cell 200、物件半徑 12）。
      // 把 cell 切細之後 —— 而切細正是提高剔除率的作法 —— 兩者變成同一
      // 個量級，錯誤才會浮現。實測 cell 12.5 時 40,000 個裡有 8 個被剔錯。
      const minX = this.cx[slot]! * size - this.margin - cameraX;
      const minZ = this.cz[slot]! * size - this.margin - cameraZ;
      const span = size + this.margin * 2;
      const relation = aabbFrustumRelation(
        frustum,
        minX,
        -this.halfHeight - cameraY,
        minZ,
        minX + span,
        this.halfHeight - cameraY,
        minZ + span,
      );
      // 0 外、1 相交、2 完全在內。**保留 2 是為了讓收集迴圈跳過那六個平面**
      // ——一個 cell 整個在視錐裡的話，裡面每個物件都必然可見，逐一去測是白工。
      this._mask[slot] = relation;
      if (relation !== 0) visible++;
    }

    this._visibleCells = visible;
    this._testedCells = tested;
    if (this.hasRanges) this.buildRanges();
  }

  /**
   * 收集可見 cell 的列範圍，排序後合併相鄰者。
   *
   * 排序看起來很貴，但它跑在**幾百個 cell** 上，而省下的是**幾十萬列**的
   * 走訪。兩者差三個數量級，所以這裡刻意用最簡單的作法。
   *
   * 合併是必要的而不是優化：依 cell 排序生成時，空間相鄰的 cell 列號也
   * 相鄰，不合併的話外層迴圈會有幾百次迭代，每次都要重新建立迴圈狀態。
   * 合併之後常常只剩個位數段。
   */
  private buildRanges(): void {
    const visibleSlots: number[] = [];
    for (let slot = 1; slot < this.highWater; slot++) {
      if (this.used[slot] === 0 || this._mask[slot] === 0) continue;
      // 沒有登記範圍的 cell 不能被略過 —— 那會讓它的內容整塊消失。
      // 這種情況整張範圍表作廢，呼叫端退回完整走訪。
      if (this.rowStart[slot]! < 0) {
        this._visibleRanges.count = 0;
        return;
      }
      visibleSlots.push(slot);
    }
    // 依起始列排序 slot 本身，而不是排序起始列再回頭找 slot ——
    // 後者需要一次線性搜尋，對幾百個 cell 就是每幀幾十萬次比較。
    visibleSlots.sort((a, b) => this.rowStart[a]! - this.rowStart[b]!);

    const bounds = this._visibleRanges.bounds;
    const inside = this._visibleRanges.inside;
    let count = 0;
    for (const slot of visibleSlots) {
      const start = this.rowStart[slot]!;
      const end = this.rowEnd[slot]!;
      const fully = this._mask[slot] === 2 ? 1 : 0;
      if (count > 0 && bounds[count * 2 - 1]! >= start) {
        // 相鄰或重疊：延長上一段。
        //
        // **合併之後的「完全在內」是每一格的 AND** —— 只要有一格只是相交，
        // 整段就不能跳過平面測試。反過來設的話，那一格裡在視錐外的物件會
        // 被當成可見送出去，而症狀是畫面邊緣多出東西、且完全不報錯。
        if (end > bounds[count * 2 - 1]!) bounds[count * 2 - 1] = end;
        if (fully === 0) inside[count - 1] = 0;
        continue;
      }
      if ((count + 1) * 2 > bounds.length) break;
      bounds[count * 2] = start;
      bounds[count * 2 + 1] = end;
      inside[count] = fully;
      count++;
    }
    this._visibleRanges.count = count;
  }

  private grow(needed: number): void {
    const n = Math.max(needed, this.used.length * 2);
    const cx = new Int32Array(n);
    const cz = new Int32Array(n);
    const used = new Uint8Array(n);
    const mask = new Uint8Array(n).fill(1);
    const rowStart = new Int32Array(n).fill(-1);
    const rowEnd = new Int32Array(n);
    cx.set(this.cx);
    cz.set(this.cz);
    used.set(this.used);
    mask.set(this._mask);
    rowStart.set(this.rowStart);
    rowEnd.set(this.rowEnd);
    this.rowStart = rowStart;
    this.rowEnd = rowEnd;
    this._visibleRanges.bounds = new Int32Array(n * 2);
    this._visibleRanges.inside = new Uint8Array(n);
    this.cx = cx;
    this.cz = cz;
    this.used = used;
    this._mask = mask;
  }
}

/**
 * 走訪用的區段清單。
 *
 * 兩個熱迴圈原本都是 `for (row = 0; row < size; row++)`。改成走訪區段之後，
 * 「有區段」與「沒有區段」如果各寫一份迴圈，那個 body 就會有兩份 ——
 * 而它是整個引擎最容易寫錯也最少被讀的地方。
 *
 * 所以沒有區段時就合成一個 `[0, size)`，迴圈只有一種形狀。多出來的一層
 * 外迴圈對數十萬列來說量不出來。
 */
export class RowSpans {
  private single = new Int32Array(2);

  /** @returns 成對排列的 `[start, end)` 與段數。 */
  resolve(
    ranges: { bounds: Int32Array; count: number } | null,
    size: number,
  ): { bounds: Int32Array; count: number } {
    if (ranges !== null && ranges.count > 0) return ranges;
    this.single[0] = 0;
    this.single[1] = size;
    return { bounds: this.single, count: 1 };
  }
}
