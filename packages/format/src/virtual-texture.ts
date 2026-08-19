/**
 * 虛擬貼圖的頁表：一張**大到配置不下**的貼圖，怎麼用一張配置得下的來表示。
 *
 * ## 它解的不是速度，是「做不做得到」
 *
 * 先前量過一次貼圖壓力，結論是「虛擬貼圖不做」——而那個量測回答的是
 * **「需不需要它來變快」**：有 mipmap 的話真正被取樣的 texel 受畫面像素數
 * 綁住，貼圖總量堆到 5.5 GB 幀時間都不動。那個結論現在還是成立。
 *
 * 但它沒有回答另一個問題：**「需不需要它才做得到」**。
 *
 * 硬體的單張貼圖有上限（常見是 16384）。一個 8 公里、每 10 公分一個 texel
 * 的地表需要 80,000 texel 一邊 —— 那不是慢，是**配置不出來**。跟 CSM 的
 * 理由是同一種：範圍拉大到某個程度，單張 map 就不成立，而不是變慢。
 *
 * 這個套件要的是「大而細緻廣闊」的世界，所以那個上限是真的會撞到的。
 *
 * ## 回退鏈在 CPU 上解，不在著色器裡
 *
 * 最直覺的做法是著色器發現這一頁不在就往粗一階找，找到為止 —— 那是每個
 * fragment 一個迴圈。而這個專案量過「每個 fragment 多做一點事」的代價，
 * 那一項是虧的。
 *
 * 所以這裡把回退**在住民變動的當下解完**：頁表裡每一格直接存「最好的那個
 * 祖先住在圖集哪裡、它是第幾階」。著色器因此只多**一次**查表，沒有迴圈。
 *
 * 代價是住民一變就要重算受影響的那一塊頁表 —— 那是幾千次陣列寫入，發生在
 * 載入的時候，不是每個 fragment。
 *
 * ## 最粗的那一階永遠釘住
 *
 * 沒有這條的話「找不到任何祖先」是可能的，而那時候著色器只能畫出垃圾。
 * 釘住最粗階（1 頁）之後，回退鏈**保證有底**：最差的情況是整張貼圖用一頁
 * 的解析度，糊，但正確。
 *
 * 糊是可以接受的失敗形態，垃圾不是。
 */

export interface VirtualTextureLayout {
  /** 一頁幾個 texel（一邊）。預設 128。 */
  pageSize?: number;
  /**
   * 最細那一階一邊幾頁。**必須是 2 的次方**。
   *
   * 虛擬解析度 = `pageSize × pagesPerSide`。要 80,000 texel 的話，
   * 128 × 1024 = 131,072 —— 遠超過硬體上限，而那正是重點。
   */
  pagesPerSide: number;
  /** 圖集一邊幾頁。`atlasPages² ` 就是同時住得下幾頁。預設 16（256 頁）。 */
  atlasPages?: number;
}

/** 一次要搬進圖集的頁。 */
export interface PageLoad {
  level: number;
  px: number;
  py: number;
  /** 搬進圖集的哪一格。 */
  slotX: number;
  slotY: number;
}

/** 頁表每一格四個位元組：圖集座標、階數、住不住。 */
export const INDIRECTION_STRIDE = 4;

interface Slot {
  level: number;
  px: number;
  py: number;
  /** 最後一次被要到是第幾輪。LRU 用。 */
  used: number;
  /** 釘住的不會被踢掉。 */
  pinned: boolean;
}

export class PageTable {
  readonly pageSize: number;
  readonly pagesPerSide: number;
  readonly atlasPages: number;
  /** 幾階。最細是 0，最粗那階只有一頁。 */
  readonly levels: number;

  /**
   * 最細階每一格指到哪裡：`[slotX, slotY, level, resident]`。
   *
   * 存最細階的解析度是刻意的：著色器拿到 UV 之後只要乘上 `pagesPerSide`
   * 就知道查哪一格，不必先決定自己該用第幾階。**該用第幾階是住民決定的，
   * 不是著色器決定的** —— 而那正是回退。
   */
  readonly indirection: Uint8Array;

  private readonly slots: (Slot | null)[];
  /** 頁的鍵（數字，見 key）→ 圖集第幾格。 */
  private readonly resident = new Map<number, number>();
  private readonly wanted = new Set<number>();
  private tick = 0;

  constructor(layout: VirtualTextureLayout) {
    this.pageSize = Math.max(4, Math.floor(layout.pageSize ?? 128));
    this.pagesPerSide = Math.max(1, Math.floor(layout.pagesPerSide));
    if ((this.pagesPerSide & (this.pagesPerSide - 1)) !== 0) {
      throw new Error(
        `WW.PageTable: pagesPerSide 必須是 2 的次方（拿到 ${this.pagesPerSide}）。` +
          '不是的話 mip 金字塔每一階的邊界會對不齊，回退就會查到隔壁頁。',
      );
    }
    this.atlasPages = Math.max(2, Math.floor(layout.atlasPages ?? 16));
    this.levels = Math.log2(this.pagesPerSide) + 1;

    this.slots = new Array<Slot | null>(this.atlasPages * this.atlasPages).fill(null);
    this.indirection = new Uint8Array(this.pagesPerSide * this.pagesPerSide * INDIRECTION_STRIDE);

    // 最粗那一階（一頁）釘在第 0 格，回退鏈因此保證有底。
    // `used` 是普通的 0，不是 Infinity —— **保護只能來自 `pinned` 一個地方**。
    // 用 Infinity 的話根頁永遠不是最舊的，於是「釘住」拿掉也不會出事，
    // 而那條測試就驗不到東西了（實測：改成 false，11 條全綠）。
    this.slots[0] = { level: this.levels - 1, px: 0, py: 0, used: 0, pinned: true };
    this.resident.set(key(this.levels - 1, 0, 0), 0);
    this.rebuildIndirection();
  }

  /** 圖集裡最粗那一階住在哪一格 —— 它是釘住的，永遠是第 0 格。 */
  get rootSlot(): { slotX: number; slotY: number } {
    return { slotX: 0, slotY: 0 };
  }

  /** 現在住了幾頁（含釘住的那一頁）。 */
  get residentCount(): number {
    return this.resident.size;
  }

  /**
   * 這一輪要用到這一頁。
   *
   * 只是登記，不會馬上搬 —— 搬在 `commit()`，而且有預算。
   */
  request(level: number, px: number, py: number): void {
    if (level < 0 || level >= this.levels) return;
    const side = this.pagesPerSide >> level;
    if (px < 0 || py < 0 || px >= side || py >= side) return;
    const k = key(level, px, py);
    this.wanted.add(k);
    const slot = this.resident.get(k);
    if (slot !== undefined) this.slots[slot]!.used = this.tick;
  }

  /**
   * 把這一輪要到的頁搬進圖集，一次最多 `budget` 頁。
   *
   * ## 為什麼要預算
   *
   * 與串流、HLOD 烘焙、全域距離場同一個理由：一次搬完是一次看得見的卡頓，
   * 分次搬的話那幾幀是糊的 —— 而糊是安全的失敗形態（回退鏈保證畫得出東西）。
   *
   * @returns 這一次實際搬了哪些頁。呼叫端拿它去做真正的上傳。
   */
  commit(budget = 8): PageLoad[] {
    this.tick++;
    const loads: PageLoad[] = [];

    for (const k of this.wanted) {
      if (loads.length >= budget) break;
      if (this.resident.has(k)) continue;
      const slot = this.evictOne();
      if (slot < 0) break; // 全部釘住或全部這一輪都要用 —— 這一幀先算了。
      const [level, px, py] = parse(k);
      const old = this.slots[slot] ?? null;
      if (old !== null) this.resident.delete(key(old.level, old.px, old.py));
      this.slots[slot] = { level, px, py, used: this.tick, pinned: false };
      this.resident.set(k, slot);
      loads.push({ level, px, py, slotX: slot % this.atlasPages, slotY: (slot / this.atlasPages) | 0 });
      // 只重算這兩頁蓋住的範圍 —— 搬進來的那一頁，以及被踢掉的那一頁。
      if (old !== null) {
        const oldSpan = 1 << old.level;
        this.rebuildRegion(old.px * oldSpan, old.py * oldSpan, oldSpan, oldSpan);
      }
      const span = 1 << level;
      this.rebuildRegion(px * span, py * span, span, span);
    }

    this.wanted.clear();
    return loads;
  }

  /** 查一個最細階的格子指到哪裡 —— 測試與除錯用，著色器走的是同一份資料。 */
  lookup(px: number, py: number): { slotX: number; slotY: number; level: number } {
    const i = (py * this.pagesPerSide + px) * INDIRECTION_STRIDE;
    return {
      slotX: this.indirection[i]!,
      slotY: this.indirection[i + 1]!,
      level: this.indirection[i + 2]!,
    };
  }

  /**
   * 挑一格出來用：先找空的，再找最久沒用到的。
   *
   * 釘住的與**這一輪要用的**都不能踢 —— 踢了就是這一幀搬進來、下一幀又被
   * 踢掉，來回搬同樣那幾頁而畫面一直是糊的。那種顛簸比少幾頁還糟。
   */
  private evictOne(): number {
    let oldest = -1;
    let oldestUsed = Infinity;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i] ?? null;
      if (slot === null) return i;
      if (slot.pinned) continue;
      if (this.wanted.has(key(slot.level, slot.px, slot.py))) continue;
      if (slot.used < oldestUsed) {
        oldestUsed = slot.used;
        oldest = i;
      }
    }
    return oldest;
  }

  /**
   * 重算整份頁表。只有建構時用一次。
   *
   * 執行期走的是 `rebuildRegion` —— 整份重算是 `pagesPerSide²` 格，而每次
   * 搬一頁就重算一次的話，512 頁一邊（26 萬格）會直接卡死。
   */
  private rebuildIndirection(): void {
    this.rebuildRegion(0, 0, this.pagesPerSide, this.pagesPerSide);
  }

  /**
   * 重算最細階的一塊矩形。
   *
   * 一頁在第 `level` 階蓋住 `2^level` 見方的最細階格子，所以搬一頁只需要
   * 重算那一塊。被踢掉的頁同理 —— 那一塊會重新往上找到別的祖先。
   */
  private rebuildRegion(x0: number, y0: number, width: number, height: number): void {
    const n = this.pagesPerSide;
    const xEnd = Math.min(n, x0 + width);
    const yEnd = Math.min(n, y0 + height);
    for (let py = Math.max(0, y0); py < yEnd; py++) {
      for (let px = Math.max(0, x0); px < xEnd; px++) {
        let level = 0;
        let slot: number | undefined;
        for (; level < this.levels; level++) {
          slot = this.resident.get(key(level, px >> level, py >> level));
          if (slot !== undefined) break;
        }
        // ## 第四個位元組要真的說實話
        //
        // 一律填 255 的話它不帶任何資訊，而**回退鏈斷掉時畫面上是垃圾、
        // 資料上卻看不出來**。填 0 代表「這一格沒有任何祖先住著」——
        // 那是不該發生的（最粗階釘著），所以它同時是一條自我檢查。
        const found = slot !== undefined;
        const s = slot ?? 0;
        const i = (py * n + px) * INDIRECTION_STRIDE;
        this.indirection[i] = s % this.atlasPages;
        this.indirection[i + 1] = (s / this.atlasPages) | 0;
        this.indirection[i + 2] = found ? level : this.levels - 1;
        this.indirection[i + 3] = found ? 255 : 0;
      }
    }
  }
}
function key(level: number, px: number, py: number): number {
  return level * 67108864 + py * 8192 + px;
}

function parse(k: number): [number, number, number] {
  const level = Math.floor(k / 67108864);
  const rest = k - level * 67108864;
  return [level, rest % 8192, Math.floor(rest / 8192)];
}

/**
 * 這個布局需要多大的實體貼圖，以及它假裝自己有多大。
 *
 * 拿來講清楚「為什麼需要虛擬貼圖」：`virtualSize` 超過硬體上限而
 * `atlasSize` 沒有，那個差距就是這個東西買到的東西。
 */
export function virtualTextureSize(layout: VirtualTextureLayout): {
  virtualSize: number;
  atlasSize: number;
  ratio: number;
} {
  const pageSize = Math.max(4, Math.floor(layout.pageSize ?? 128));
  const atlasPages = Math.max(2, Math.floor(layout.atlasPages ?? 16));
  const virtualSize = pageSize * Math.max(1, Math.floor(layout.pagesPerSide));
  const atlasSize = pageSize * atlasPages;
  return { virtualSize, atlasSize, ratio: virtualSize / atlasSize };
}
