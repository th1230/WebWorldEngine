import type { EntityId } from '@ww/core';

/**
 * World Cell 串流。
 *
 * ## 為什麼需要它
 *
 * 真正的開放世界裝不進記憶體，內容必須隨著相機移動而載入與卸載。
 * 「開場一次生成好」對量測渲染管線是夠的，但那不是世界。
 *
 * ## 三個必須一開始就對的設計點
 *
 * **1. 遲滯（hysteresis）。** 載入半徑與卸載半徑**不能相同**。相同的話，
 * 相機停在邊界上會讓同一個 cell 反覆載入卸載 —— 每幀都在做最貴的工作，
 * 而畫面看起來完全正常。這是串流最經典的失效模式。
 *
 * **2. 預算。** 一次把所有該載的 cell 都載完會造成明顯卡頓。每幀限制
 * 載入數量，其餘排隊等下一幀。這對應規格的「GPU/CPU 預算」。
 *
 * **3. 優先序。** 預算有限時先載近的。載遠的會讓玩家眼前出現空洞，
 * 而那正是最容易被看見的地方。
 *
 * ## 為什麼 cell 內容由呼叫端提供
 *
 * 引擎不知道「一個 cell 裡有什麼」—— 那是資產與遊戲的事。串流器只負責
 * **何時**載入卸載，內容由 `CellSource` 決定。這條界線讓同一套串流邏輯
 * 能同時服務程序化世界與 cooked 世界。
 */

export interface CellSource<T = EntityId> {
  /**
   * 載入一個 cell，回傳它建立的所有 entity。
   *
   * **必須是決定性的**：同樣的 (cellX, cellZ) 必須產生同樣的內容。
   * 否則走出去再走回來，世界會變成另一個樣子 —— 那種 bug 在巡遊測試裡
   * 表現為「記憶體沒漏但畫面對不上」，極難歸因。
   */
  load(cellX: number, cellZ: number): Promise<T[]> | T[];
  /**
   * 載入一個 cell 的**代理內容**（HLOD）—— 用極少的 entity 表示整個 cell。
   *
   * 沒有實作就等於關閉代理層：串流退化成只有一個半徑，行為與先前完全相同。
   *
   * 代理層存在的理由是 r²：等密度下常駐內容隨視距的平方成長，實測
   * 視野從 3.5 個 cell 深拉到 10 個，常駐就從 44,000 漲到 328,000。
   * 要看到地平線又不炸掉記憶體，遠處就不能是完整內容。
   */
  loadProxy?(cellX: number, cellZ: number): Promise<T[]> | T[];
  /**
   * 卸載一批 entity。必須釋放 ECS row 與資產參考。
   *
   * **這不代表 cell 消失了。** 層級變更（full ↔ proxy）也會呼叫它 ——
   * 舊層級的 entity 被卸掉，但 cell 仍然常駐，只是換了內容。
   *
   * 單層的時候兩者是同一件事，加上代理層之後就不是了。把「這批 entity
   * 沒了」與「這個 cell 沒了」混在一起，會讓呼叫端在層級變更時釋放掉
   * 仍在使用中的資源 —— 實際踩到過：cell 的可見性槽位被提早釋放，
   * 新的代理物於是跟著別的 cell 的可見性走。
   */
  unload(cellX: number, cellZ: number, entities: readonly T[]): void;
  /**
   * 這個 cell **完全離開**了常駐集合。
   *
   * 與 `unload` 的差別見上。cell 層級的資源（可見性槽位、HLOD 快取、
   * 空間索引項目）應該在這裡釋放，而不是在 `unload`。
   */
  releaseCell?(cellX: number, cellZ: number): void;
}

export interface StreamingOptions {
  /** cell 的邊長（世界單位）。 */
  cellSize: number;
  /** 相機周圍多遠以內的 cell 要載入。 */
  loadRadius: number;
  /**
   * 超過多遠才卸載。**必須大於 `loadRadius`**。
   *
   * 兩者相同的話，相機在邊界上來回移動幾公分就會讓 cell 反覆載入卸載。
   * 差值就是遲滯帶 —— 它換來的是「不會在邊界上抖動」。
   */
  unloadRadius: number;
  /**
   * 同時進行中的載入上限。
   *
   * 從「每幀最多載幾個」改成「同時最多幾個在飛」：非同步之後，一個載入
   * 可能橫跨數十幀，用「每幀」計數會讓在途的請求無限累積。
   */
  maxConcurrentLoads?: number;
  /**
   * 代理層的外半徑。**必須大於 unloadRadius**，且需要 CellSource.loadProxy。
   *
   * loadRadius 以內是完整內容，到 proxyRadius 之間只有代理物。
   * 沒設就等於沒有代理層。
   */
  proxyRadius?: number;
  /**
   * 代理物超過多遠才卸載。**必須大於 proxyRadius**，預設為它的 1.15 倍。
   *
   * 與 unloadRadius 同一個道理：外緣也是一條邊界，一樣會抖動。
   */
  proxyUnloadRadius?: number;
  /**
   * 代理層的併發載入上限，預設是 maxConcurrentLoads 的 16 倍。
   *
   * 兩層共用一個數字是錯的：預算存在的理由是「載入很貴」，而一個代理
   * 載入只產生 1 個 entity，比完整載入便宜三個數量級。用個數當預算等於
   * 在量錯的東西。
   *
   * 實測共用預算 2 時，代理環該有約 340 個 cell 卻只填到 72 個，
   * 佇列永遠積著 206 個 —— 而所有數字看起來都很漂亮，因為**世界是空的**。
   */
  maxConcurrentProxyLoads?: number;
  /** 每幀最多卸載幾個 cell。卸載較便宜，預設比載入寬鬆。 */
  maxUnloadsPerFrame?: number;
  /**
   * 每幀的時間預算（毫秒）。設了就啟用自適應載入。
   *
   * ## 為什麼是幀時間而不是 CPU 時間
   *
   * 直覺會想「限制串流的 CPU 用量」。實測那是錯的方向：
   *
   * ```text
   * 有 cell 完成載入的幀   CPU 1.409 ms
   * 沒有的幀               CPU 1.099 ms
   * ```
   *
   * 差 0.31 ms，而幀時間的 p95 比 p50 高 14 ms。**卡頓不在 CPU 端。**
   *
   * 真正的成本在 GPU：相機靜止時 GPU p95 是 13.74 ms，以速度 48 移動時
   * 變成 23.71 ms —— 新 cell 進入視野會讓 instance buffer 重新配置與上傳，
   * 而那筆錢是 GPU 付的。
   *
   * 所以預算看的是**整幀時間**，控制的是「每幀讓多少新內容進場」。
   * 只量 CPU 的話，串流器會覺得自己很閒而一路加碼。
   */
  frameBudgetMs?: number;
}

/**
 * Cell 的狀態。
 *
 * 完整的載入狀態機有八個狀態（Unloaded → Metadata → Requested → Downloading →
 * Decoded → Resident → Activated → Retiring → Evicted）。那些狀態是為了
 * **非同步載入**存在的 —— 目前的內容是同步產生的程序化資料，多出來的
 * 狀態只會是永遠不會被觀察到的空殼。等接上真實資產的非同步載入時再補。
 */
export type CellState = 'resident' | 'loading' | 'pending';

export interface StreamingStats {
  /** 目前常駐的 cell 數。 */
  resident: number;
  /** 正在載入中的 cell 數。 */
  loading: number;
  /** 排隊等待開始的 cell 數。持續不為 0 代表預算追不上移動速度。 */
  pending: number;
  /** 目前由串流器管理的 entity 總數。 */
  entities: number;
  /** 累計載入次數。 */
  totalLoads: number;
  /** 累計卸載次數。 */
  totalUnloads: number;
  /**
   * 載入完成時已經不再需要、因而立刻被卸載的次數。
   *
   * 持續很高代表相機移動快於載入速度 —— 一直在做白工。
   * 這個數字本身不是錯誤，但它是「載入預算或半徑設定不當」的指標。
   */
  cancelledLoads: number;
  /**
   * 層級變更次數（full ↔ proxy）。
   *
   * 持續飆高代表兩條邊界的遲滯帶太窄 —— 而症狀只是「莫名其妙很慢」，
   * 因為每一次變更都是整個 cell 的內容重建。
   */
  tierChanges: number;
  /** 目前是代理層的 cell 數。 */
  proxyCells: number;
  /** 載入失敗的次數。不為 0 就代表有 cell 永遠不會出現。 */
  failedLoads: number;
  /** 最後一次載入失敗的訊息，供診斷用。 */
  lastError: string | null;
}

/**
 * Cell 的內容層級。
 *
 * full 是完整內容，proxy 是代表整個 cell 的少量 entity。
 * 兩者共用同一套載入卸載路徑 —— 差別只在呼叫 source 的哪個方法。
 */
export type CellTier = 'full' | 'proxy';

interface ResidentCell<T> {
  cx: number;
  cz: number;
  tier: CellTier;
  entities: T[];
}

export class WorldStreamer<T = EntityId> {
  private readonly source: CellSource<T>;
  private readonly cellSize: number;
  private readonly loadRadius: number;
  private readonly unloadRadius: number;
  private readonly proxyRadius: number;
  private readonly proxyUnloadRadius: number;
  private readonly outerRadius: number;
  private readonly maxConcurrent: number;
  private frameBudgetMs: number;
  /** 自適應之後實際使用的併發上限。預算關閉時等於 maxConcurrent。 */
  private adaptiveConcurrent = 1;
  private readonly maxConcurrentProxy: number;
  private readonly maxUnloads: number;

  private readonly resident = new Map<number, ResidentCell<T>>();
  /** 想載但受併發限制還沒開始的 cell，值是與相機的距離平方（優先序）。 */
  private readonly pendingList: Array<{ key: number; d: number; tier: CellTier }> = [];
  private pendingCapacity = 0;
  /** 上一次掃描時相機所在的 cell。NaN 代表還沒掃過。 */
  private scannedCellX = Number.NaN;
  private scannedCellZ = Number.NaN;
  /** 這一幀有多少 cell 想載入。清單只留最近的 K 個，這個數字才是全貌。 */
  private _pendingTotal = 0;
  /**
   * 正在載入中的 cell。
   *
   * 沒有這個集合，`enqueue` 每一幀都會看到「它不在 resident 裡」而重新
   * 發出載入 —— 同一個 cell 被載入數十次，entity 直接翻倍。
   */
  private readonly loading = new Map<number, CellTier>();
  /**
   * 載入途中被判定為不再需要的 cell。
   *
   * 完成時要立刻卸載而不是納入常駐。這是非同步串流最容易漏掉的一條路徑：
   * 只在「相機移動快於載入速度」時才會走到。
   */
  private readonly cancelled = new Set<number>();

  private _totalLoads = 0;
  private _totalUnloads = 0;
  private _cancelledLoads = 0;
  private _failedLoads = 0;
  private _lastError: string | null = null;
  private _entities = 0;
  /** 層級變更次數（full ↔ proxy）。持續飆高代表遲滯帶太窄。 */
  private _tierChanges = 0;
  private _evictMs = 0;
  private _enqueueMs = 0;
  private _admitMs = 0;
  private _updateCount = 0;
  private _sourceMs = 0;

  constructor(source: CellSource<T>, options: StreamingOptions) {
    if (!(options.cellSize > 0)) throw new Error('cellSize 必須為正數');
    if (!(options.unloadRadius > options.loadRadius)) {
      // 這不是可以「之後再調」的參數。相同的話 cell 會在邊界上永久抖動，
      // 而症狀是幀時間莫名其妙地高，畫面卻完全正常。
      throw new Error(
        `unloadRadius (${options.unloadRadius}) 必須大於 loadRadius (${options.loadRadius})，` +
          '否則 cell 會在邊界上反覆載入卸載',
      );
    }
    /**
     * 代理層需要 source 真的實作 `loadProxy`。
     *
     * 只設半徑卻沒有實作的話，遠處的 cell 會被排進佇列、載入時拿不到內容，
     * 於是每一幀都重排一次同樣的 cell —— 畫面正常（遠處本來就空），
     * CPU 卻在做無止盡的白工。那種形態極難從症狀反推，所以擋在建構子。
     */
    const wantsProxy = options.proxyRadius !== undefined;
    if (wantsProxy && source.loadProxy === undefined) {
      throw new Error('設定了 proxyRadius，但 CellSource 沒有實作 loadProxy');
    }
    if (wantsProxy && !(options.proxyRadius! > options.unloadRadius)) {
      throw new Error(
        `proxyRadius (${options.proxyRadius}) 必須大於 unloadRadius (${options.unloadRadius})，` +
          '否則代理層沒有存在的空間',
      );
    }

    this.source = source;
    this.cellSize = options.cellSize;
    this.loadRadius = options.loadRadius;
    this.unloadRadius = options.unloadRadius;
    this.proxyRadius = options.proxyRadius ?? 0;
    // 外緣也是一條邊界，一樣會抖動 —— 與 unloadRadius 同一個道理。
    this.proxyUnloadRadius = options.proxyUnloadRadius ?? this.proxyRadius * 1.15;
    if (wantsProxy && !(this.proxyUnloadRadius > this.proxyRadius)) {
      throw new Error(
        `proxyUnloadRadius (${this.proxyUnloadRadius}) 必須大於 proxyRadius (${this.proxyRadius})`,
      );
    }
    /** 最外圈：超過這個距離的 cell 不留任何東西。 */
    this.outerRadius = wantsProxy ? this.proxyUnloadRadius : options.unloadRadius;
    this.maxConcurrent = Math.max(1, options.maxConcurrentLoads ?? 4);
    this.maxConcurrentProxy = Math.max(
      1,
      options.maxConcurrentProxyLoads ?? this.maxConcurrent * 16,
    );
    this.maxConcurrentProxy = Math.max(
      1,
      options.maxConcurrentProxyLoads ?? this.maxConcurrent * 16,
    );
    this.maxUnloads = Math.max(1, options.maxUnloadsPerFrame ?? 8);
    this.pendingCapacity = (this.maxConcurrent + this.maxConcurrentProxy) * 4;
    this.frameBudgetMs = options.frameBudgetMs ?? 0;
    this.adaptiveConcurrent = this.maxConcurrent;
  }

  /**
   * 依相機位置更新常駐集合。每幀呼叫一次。
   *
   * 順序是**先卸載再載入**：先騰出空間，尖峰記憶體才不會是「舊的還在、
   * 新的已經進來」的總和。
   */
  /**
   * 回報上一幀的實際耗時，讓串流器調整載入速率。
   *
   * 只有設了 `frameBudgetMs` 才有作用。呼叫端不必每幀都給 —— 沒給就維持
   * 目前的速率。
   *
   * 調整刻意**不對稱**：超出預算時砍半，有餘裕時每次只加 0.25。對稱的話
   * 會在預算邊界上振盪 —— 加碼 → 超出 → 減速 → 有餘裕 → 加碼，而每個
   * 週期都伴隨一次看得見的卡頓。這與兩條半徑的遲滯是同一個道理。
   *
   * 「明顯有餘裕」訂在 80%：貼著預算加碼等於刻意讓每一幀都踩線。
   */
  /**
   * 換一個幀預算。
   *
   * 存在的理由是**預算不該由作者猜**：對的值是「這台機器自己的基準幀時間」，
   * 而那只有在使用者的機器上跑起來才量得到。呼叫端量到之後設進來。
   */
  setFrameBudgetMs(budgetMs: number): void {
    this.frameBudgetMs = budgetMs;
  }

  reportFrameMs(frameMs: number): void {
    if (this.frameBudgetMs <= 0) return;
    if (frameMs > this.frameBudgetMs) {
      this.adaptiveConcurrent = Math.max(1, this.adaptiveConcurrent * 0.5);
    } else if (frameMs < this.frameBudgetMs * 0.8) {
      this.adaptiveConcurrent = Math.min(this.maxConcurrent, this.adaptiveConcurrent + 0.25);
    }
  }

  /** 目前的自適應併發上限。預算關閉時等於 `maxConcurrentLoads`。 */
  get loadRate(): number {
    return this.adaptiveConcurrent;
  }

  update(cameraX: number, cameraZ: number): void {
    // 三個階段各自計時。合起來的數字只能告訴你「串流很貴」，
    // 而那句話不足以決定要改哪裡 —— 這一整段的教訓就是這個。
    const t0 = performance.now();
    this.evict(cameraX, cameraZ);
    const t1 = performance.now();
    this.enqueue(cameraX, cameraZ);
    const t2 = performance.now();
    this.admit();
    const t3 = performance.now();
    this._evictMs += t1 - t0;
    this._enqueueMs += t2 - t1;
    this._admitMs += t3 - t2;
    this._updateCount++;
  }

  /** 三個階段的每幀平均耗時，以及重置。 */
  get phaseTimings(): {
    evictMs: number;
    enqueueMs: number;
    admitMs: number;
    sourceMs: number;
    frames: number;
  } {
    const n = Math.max(1, this._updateCount);
    return {
      evictMs: this._evictMs / n,
      // admit 扣掉呼叫端產生內容的時間，剩下的才是串流器自己的開銷
      admitMs: (this._admitMs - this._sourceMs) / n,
      enqueueMs: this._enqueueMs / n,
      sourceMs: this._sourceMs / n,
      frames: this._updateCount,
    };
  }

  resetPhaseTimings(): void {
    this._evictMs = 0;
    this._enqueueMs = 0;
    this._admitMs = 0;
    this._updateCount = 0;
    this._sourceMs = 0;
  }

  /**
   * 卸載超出**最外圈**的 cell。
   *
   * 注意這裡用的是 `outerRadius` 而不是 `unloadRadius`：有代理層時，
   * 一個離開 `unloadRadius` 的完整 cell 不該被卸載，而是要**降級成代理**。
   * 那件事由 `enqueue` 處理 —— 它會排一個 proxy 載入，完成時才換掉舊內容。
   *
   * 先卸載再載入會在畫面上留下一個空洞的中間幀。所以層級變更走的是
   * 「新的到了才換掉舊的」，而 evict 只負責「這裡什麼都不該有」。
   */
  private evict(cameraX: number, cameraZ: number): void {
    const limit = this.outerRadius * this.outerRadius;
    let budget = this.maxUnloads;

    for (const [key, cell] of this.resident) {
      if (budget <= 0) break;
      if (this.distanceSq(cell.cx, cell.cz, cameraX, cameraZ) <= limit) continue;

      this.source.unload(cell.cx, cell.cz, cell.entities);
      this._entities -= cell.entities.length;
      this.resident.delete(key);
      this.source.releaseCell?.(cell.cx, cell.cz);
      this._totalUnloads++;
      budget--;
    }

    // 載入途中就走遠的 cell 要標記取消。完成時 `settle` 會立刻把它建立的
    // entity 卸掉 —— 只是丟掉 promise 的話，那些 entity 會永遠留在世界裡。
    for (const key of this.loading.keys()) {
      if (this.cancelled.has(key)) continue;
      if (this.distanceSq(unpackX(key), unpackZ(key), cameraX, cameraZ) > limit) {
        this.cancelled.add(key);
      }
    }
  }

  /**
   * 決定每個 cell**應該**是哪一層，把不符的排進佇列。
   *
   * 兩條邊界各有自己的遲滯：
   *
   * ```text
   *   |<--- full --->|<-- 遲滯 -->|<---- proxy ---->|<- 遲滯 ->|
   *   0          loadRadius   unloadRadius      proxyRadius  proxyUnloadRadius
   * ```
   *
   * 已經是 full 的 cell 在 `unloadRadius` 以內都維持 full，不會一越過
   * `loadRadius` 就降級 —— 否則相機在那條線上前後移動就會讓整個 cell
   * 的內容反覆重建，而那正是代理層最貴的操作。
   */
  private enqueue(cameraX: number, cameraZ: number): void {
    /**
     * 相機還在同一個 cell 裡、而且候選清單還沒用完時，整個掃描可以跳過。
     *
     * 掃描是這個系統最貴的東西：實測視距 16,000 時 `update()` 佔 CPU 幀的
     * **74%**（4.211 ms／5.70 ms），全部在走訪 161×161 = 25,921 個座標。
     * 而相機是平滑移動的 —— 需要載入的集合只有在**跨越 cell 邊界**時
     * 才會改變。
     *
     * 兩個重新掃描的條件缺一不可：
     *
     * - 相機換了 cell：需要的集合真的變了
     * - 候選清單空了：`admit` 把上一輪的都送出去了，不重掃就會停止載入
     *
     * 少了第二條，開場時會 admit 掉最初的 K 個之後永遠不再載入 ——
     * 而畫面只是「遠處一直是空的」，不會有任何錯誤。
     */
    const cellX = Math.floor(cameraX / this.cellSize);
    const cellZ = Math.floor(cameraZ / this.cellSize);
    if (cellX === this.scannedCellX && cellZ === this.scannedCellZ && this.pendingList.length > 0) {
      return;
    }
    this.scannedCellX = cellX;
    this.scannedCellZ = cellZ;

    this.pendingList.length = 0;
    this._pendingTotal = 0;
    const fullLimit = this.loadRadius * this.loadRadius;
    const keepFullLimit = this.unloadRadius * this.unloadRadius;
    const hasProxy = this.proxyRadius > 0;
    const proxyLimit = hasProxy ? this.proxyRadius * this.proxyRadius : 0;
    const keepProxyLimit = hasProxy ? this.proxyUnloadRadius * this.proxyUnloadRadius : 0;

    const outer = hasProxy ? this.proxyRadius : this.loadRadius;
    const reach = Math.ceil(outer / this.cellSize);
    const centreX = Math.floor(cameraX / this.cellSize);
    const centreZ = Math.floor(cameraZ / this.cellSize);

    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const cx = centreX + dx;
        const cz = centreZ + dz;
        const key = cellKey(cx, cz);
        const d = this.distanceSq(cx, cz, cameraX, cameraZ);
        const existing = this.resident.get(key);

        let want: CellTier | null;
        if (d <= fullLimit) want = 'full';
        else if (existing?.tier === 'full' && d <= keepFullLimit) want = 'full';
        else if (!hasProxy) want = null;
        else if (d <= proxyLimit) want = 'proxy';
        else if (existing?.tier === 'proxy' && d <= keepProxyLimit) want = 'proxy';
        else want = null;

        if (want === null) continue;
        // 已經是對的層級就不動；正在載入同一層級的也不能再排一次，
        // 否則同一個 cell 會被載入多次，entity 直接翻倍。
        if (existing?.tier === want) continue;
        if (this.loading.get(key) === want) continue;

        this._pendingTotal++;
        this.offer(key, d, want);
      }
    }
  }

  /**
   * 把一個候選放進「最近的 K 個」清單，維持依距離遞增。
   *
   * 原本是把**全部**候選塞進一個 Map，`admit` 再整個排序。每幀最多只
   * admit 幾十個，所以維護七萬個候選是純浪費 —— 而且那個浪費隨視距的
   * 平方成長，與常駐量完全無關。
   *
   * 實測視距 32,000 時待載清單有 71,462 筆，CPU 46.20 ms；同樣的常駐量
   * 在視距 16,000 時只有 15,182 筆、12.90 ms。**牆是串流器自己的每幀
   * 成本，不是世界的大小。**
   *
   * K 取併發上限的 4 倍：足以吸收「最近的幾個剛好都在載入中」的情況，
   * 又遠小於候選總數。
   */
  private offer(key: number, d: number, tier: CellTier): void {
    const list = this.pendingList;
    const limit = this.pendingCapacity;
    if (list.length >= limit && d >= list[list.length - 1]!.d) return;

    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid]!.d < d) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, { key, d, tier });
    if (list.length > limit) list.pop();
  }

  /**
   * 在併發預算內開始載入佇列中最近的 cell。
   *
   * ## 非同步之後多出來的三個失效模式
   *
   * **1. 完成時已經不該存在。** 載入橫跨數十幀，相機可能早就走遠了。
   * 這時候不能只是「丟掉 promise」—— 載入**已經建立了 entity**，必須把它們
   * 交給 `unload` 清掉。單純忽略結果就是洩漏，而且是最難查的那種：
   * 只在「快速移動」時才發生。
   *
   * **2. 亂序完成。** 兩個 cell 的載入可能以任意順序結束，所以每個完成
   * 都必須自己檢查「我還該不該常駐」，不能假設順序。
   *
   * **3. 重複發出。** 一個 cell 在載入途中，下一幀的 `enqueue` 又會看到
   * 它不在 `resident` 裡。必須用 `loading` 集合擋掉，否則同一個 cell 會
   * 被載入好幾次，entity 直接翻倍。
   */
  private admit(): void {
    if (this.pendingList.length === 0) return;

    /**
     * 兩層各有自己的預算。
     *
     * 共用一個數字是錯的：預算存在的理由是「載入很貴」，而一個代理載入
     * 只產生 1 個 entity，比完整載入便宜三個數量級。實測共用預算 2 時，
     * 代理環該有約 340 個 cell 卻只填到 72，佇列永遠積著 206 個 ——
     * 而所有效能數字看起來都很漂亮，**因為世界是空的**。
     */
    let fullSlots = Math.round(this.adaptiveConcurrent);
    let proxySlots = this.maxConcurrentProxy;
    for (const tier of this.loading.values()) {
      if (tier === 'proxy') proxySlots--;
      else fullSlots--;
    }
    if (fullSlots <= 0 && proxySlots <= 0) return;

    // 清單在 enqueue 時就維持依距離遞增，這裡不必再排序。
    //
    // 送出的項目必須從清單移除。跳過掃描時清單會沿用到下一幀，
    // 留著已經在載入中的項目會讓它們被重複送出 —— entity 直接翻倍。
    const ordered = this.pendingList.slice();
    this.pendingList.length = 0;

    for (let i = 0; i < ordered.length; i++) {
      const want = ordered[i]!;
      const key = want.key;
      if (want.tier === 'proxy') {
        if (proxySlots <= 0) {
          this.pendingList.push(want);
          continue;
        }
        proxySlots--;
      } else {
        if (fullSlots <= 0) {
          this.pendingList.push(want);
          continue;
        }
        fullSlots--;
      }
      const cx = unpackX(key);
      const cz = unpackZ(key);

      this.loading.set(key, want.tier);

      // 兩層共用同一條路徑，差別只在呼叫哪個方法。分成兩套流程的話，
      // 取消與亂序的處理會有一份只在代理層才走到 —— 那份一定會出錯。
      // 內容產生的時間要與串流器自己的開銷分開記。
      // 合在一起的話，「admit 很貴」會被讀成串流器有問題，
      // 而實際上那是呼叫端在生成 1000 個 entity。
      const sourceStart = performance.now();
      const produce =
        want.tier === 'proxy' ? this.source.loadProxy!(cx, cz) : this.source.load(cx, cz);
      this._sourceMs += performance.now() - sourceStart;

      // 同步來源直接完成，非同步來源走 microtask。兩者共用同一條路徑，
      // 所以取消與亂序的處理不會有「只在非同步時才對」的分支。
      void Promise.resolve(produce).then(
        (entities) => this.settle(key, cx, cz, want.tier, entities),
        (error: unknown) => {
          this.loading.delete(key);
          this._failedLoads++;
          this._lastError = error instanceof Error ? error.message : String(error);
        },
      );
    }
  }

  /**
   * 一次載入完成。決定它該常駐還是立刻卸載。
   *
   * `cancelled` 是關鍵：相機在載入期間走遠的話，這個 cell 已經不該存在了。
   * 但 entity **已經被建立**，所以必須走完整的卸載流程 —— 直接丟棄就是洩漏。
   */
  private settle(key: number, cx: number, cz: number, tier: CellTier, entities: T[]): void {
    this.loading.delete(key);

    if (this.cancelled.has(key)) {
      this.cancelled.delete(key);
      this.source.unload(cx, cz, entities);
      this._cancelledLoads++;
      // 取消的載入若不是替換既有內容，這個 cell 從頭到尾沒有常駐過 ——
      // 但呼叫端在載入時可能已經配置了 cell 層級的資源。
      if (!this.resident.has(key)) this.source.releaseCell?.(cx, cz);
      return;
    }

    // 層級變更：舊的內容在這一刻才卸掉。先卸再載會留下一個空洞的中間幀，
    // 而那在畫面上就是「遠處的東西閃一下才變成代理物」。
    const previous = this.resident.get(key);
    if (previous !== undefined) {
      this.source.unload(previous.cx, previous.cz, previous.entities);
      this._entities -= previous.entities.length;
      this._tierChanges++;
    }

    this.resident.set(key, { cx, cz, tier, entities });
    this._entities += entities.length;
    this._totalLoads++;
  }

  private countProxyCells(): number {
    let n = 0;
    for (const cell of this.resident.values()) if (cell.tier === 'proxy') n++;
    return n;
  }

  /** cell 中心到相機的水平距離平方。 */
  private distanceSq(cx: number, cz: number, cameraX: number, cameraZ: number): number {
    const centreX = (cx + 0.5) * this.cellSize;
    const centreZ = (cz + 0.5) * this.cellSize;
    const dx = centreX - cameraX;
    const dz = centreZ - cameraZ;
    return dx * dx + dz * dz;
  }

  get stats(): StreamingStats {
    return {
      resident: this.resident.size,
      loading: this.loading.size,
      pending: this._pendingTotal,
      entities: this._entities,
      totalLoads: this._totalLoads,
      totalUnloads: this._totalUnloads,
      cancelledLoads: this._cancelledLoads,
      tierChanges: this._tierChanges,
      proxyCells: this.countProxyCells(),
      failedLoads: this._failedLoads,
      lastError: this._lastError,
    };
  }

  /** 卸載全部。場景結束時呼叫，確認沒有殘留。 */
  dispose(): void {
    for (const cell of this.resident.values()) {
      this.source.unload(cell.cx, cell.cz, cell.entities);
      this._entities -= cell.entities.length;
      this._totalUnloads++;
    }
    this.resident.clear();
    this.pendingList.length = 0;
    this._pendingTotal = 0;
    // 在途的載入完成時會走 settle，屆時 cancelled 會讓它們立刻卸載。
    // 不能只清空 loading —— 那樣它們建立的 entity 就沒有人會清掉了。
    for (const key of this.loading.keys()) this.cancelled.add(key);
  }
}

/**
 * cell 座標的合法範圍。
 *
 * 鍵用 `cx * 2²⁶ + cz` 打包成單一數值。f64 能精確表示到 2⁵³ 的整數，
 * 而最大值 `2²⁵ × 2²⁶ ≈ 2.3 × 10¹⁵` 遠低於 `9 × 10¹⁵`，所以完全精確。
 *
 * 不用 JS 的位元運算：那些運算子會先把運算元轉成 **32 位元**，
 * 兩個座標各只剩 16 位元。
 *
 * > **這正是實測抓到的 bug。** 原本的實作是 `(cx & 0xffff) << 16 | (cz & 0xffff)`，
 * > 而註解寫著「涵蓋 ±200 萬世界單位，遠超過任何實際世界」—— 那句話本身是錯的：
 * > 200 單位的 cell 只能涵蓋到 ±650 萬，而且**沒有任何測試驗證過它**。
 * >
 * > 在 z = 10,000,000 處跑串流場景時，cz = 50,000 溢位成 −15,536，
 * > 於是 cell 鍵互撞、內容被放到世界另一頭。症狀是「可見 0、常駐掉到 1/22、
 * > 載入卸載次數暴增 2.6 倍」—— 看起來像串流壞了，實際上是座標繞回去了。
 */
const CELL_COORD_LIMIT = 1 << 25;
const CELL_KEY_STRIDE = 1 << 26;

export function cellKey(cx: number, cz: number): number {
  // 超出範圍就丟錯，不要靜默繞回去。繞回去的症狀完全不像「座標越界」，
  // 而是「串流莫名其妙壞掉」—— 那種錯誤要花很久才會被歸因對。
  if (
    cx >= CELL_COORD_LIMIT ||
    cx < -CELL_COORD_LIMIT ||
    cz >= CELL_COORD_LIMIT ||
    cz < -CELL_COORD_LIMIT
  ) {
    throw new Error(
      `cell 座標 (${cx}, ${cz}) 超出 ±${CELL_COORD_LIMIT} 的可表示範圍。` +
        '請增大 cellSize，或改用分層的 cell 索引。',
    );
  }
  return cx * CELL_KEY_STRIDE + cz;
}

/** 從鍵還原座標。除法取整再取餘，兩者在 f64 的整數範圍內都是精確的。 */
function unpackX(key: number): number {
  return Math.round((key - unpackZ(key)) / CELL_KEY_STRIDE);
}

function unpackZ(key: number): number {
  const rem = key % CELL_KEY_STRIDE;
  // JS 的 % 對負數回傳負值，需要修正到 [-2²⁵, 2²⁵) 的對稱範圍
  if (rem >= CELL_COORD_LIMIT) return rem - CELL_KEY_STRIDE;
  if (rem < -CELL_COORD_LIMIT) return rem + CELL_KEY_STRIDE;
  return rem;
}
