/**
 * 軟體遮蔽緩衝：在 CPU 上畫一張很小的深度圖，用來問「這個盒子被擋住了嗎」。
 *
 * ## 為什麼是 CPU、為什麼是軟體
 *
 * 剔除的結果**這一幀就要用**。GPU 的遮蔽查詢要等一幀才拿得到答案，而那一幀
 * 的延遲在畫面上是「物件晚一幀才出現」—— 那是拿正確性換效能，與「丟到
 * worker」被否決的理由完全一樣（見 roadmap）。
 *
 * 所以這裡自己畫。解析度很小（預設 256×144），因為它要回答的是「有沒有被
 * 完全遮住」，不是「長什麼樣子」。
 *
 * ## 保守的方向只有一個
 *
 * 剔除錯了的兩種後果**不對稱**：
 *
 * | 錯法 | 後果 |
 * | --- | --- |
 * | 該剔的沒剔 | 慢一點 |
 * | 不該剔的剔了 | **東西不見了** |
 *
 * 所以每一個近似都往「少剔一點」倒：
 *
 * - 遮蔽物只用**確定在物體內部**的盒子（呼叫端負責給），不用外接盒 ——
 *   外接盒比物體大，拿它當遮蔽物會擋掉其實看得見的東西。
 * - 遮蔽物跨過近平面時**整個不用**，不做裁剪。
 * - 每個三角形的深度取三個頂點裡**最遠**的。
 * - 被測物的螢幕範圍**往外擴一個像素**，蓋掉像素中心取樣在邊緣的誤差。
 * - 被測物只要有一點點在畫面外就不剔 —— 畫面外沒有遮蔽物資料。
 *
 * ## 深度存的是什麼
 *
 * 存的是**視空間距離**（裁剪空間的 w），越大越遠。
 *
 * 每個像素存的是「超過這個距離就一定被擋住」的門檻，也就是所有蓋住這個像素
 * 的遮蔽物之中，各自最遠的那一點，再取**最小**：
 *
 * - 遮蔽物 A 蓋住這個像素、最遠到 10 → 比 10 遠的都被擋住
 * - 遮蔽物 B 蓋住同一個像素、最遠到 50 → 比 50 遠的都被擋住
 * - 兩個一起看：比 10 遠的就被擋住了（A 自己就夠）
 *
 * 所以取 min。初始值是無限大 —— 什麼都擋不住。
 */

/** 粗層每個方塊的邊長。 */
const TILE = 8;

/**
 * 盒子的 12 個三角形，角的索引順序是 `x + 2y + 4z`（0 = min、1 = max）。
 *
 * 每個面都照**逆時針朝外**排 —— 背面剔除靠的就是這個順序。排錯的話畫進去的
 * 會是背面，而背面的深度是盒子的**後**面，門檻整個偏遠，於是它幾乎擋不住
 * 任何東西。那個錯不會報錯，只會讓遮蔽剔除看起來「沒什麼效果」。
 */
const BOX_TRIANGLES = new Uint8Array([
  0, 2, 3, 0, 3, 1, // z = min
  4, 5, 7, 4, 7, 6, // z = max
  0, 1, 5, 0, 5, 4, // y = min
  2, 6, 7, 2, 7, 3, // y = max
  0, 4, 6, 0, 6, 2, // x = min
  1, 3, 7, 1, 7, 5, // x = max
]);

export class OcclusionBuffer {
  readonly width: number;
  readonly height: number;
  /** 每個像素的門檻：比這個遠就被擋住。 */
  private readonly depth: Float32Array;
  /**
   * 粗層：每個 8×8 方塊裡 `depth` 的**最大值**。
   *
   * 測試問的是「這個範圍裡**每一個**像素都擋得住嗎」，所以要看最壞的那個
   * 像素 —— 門檻最大、最不會擋住東西的那一個。方塊的最大值比被測物的近距離
   * 還小的話，整塊都擋得住，不必逐像素看。
   */
  private readonly tileMax: Float32Array;
  private readonly tilesX: number;
  private readonly tilesY: number;
  private readonly sx = new Float32Array(8);
  private readonly sy = new Float32Array(8);
  private dirtyTiles = false;

  /** 診斷用：這一幀畫進去幾個遮蔽物、測了幾次、剔掉幾個。 */
  occludersDrawn = 0;
  tested = 0;
  culled = 0;

  constructor(width = 256, height = 144) {
    this.width = width;
    this.height = height;
    this.depth = new Float32Array(width * height);
    this.tilesX = Math.ceil(width / TILE);
    this.tilesY = Math.ceil(height / TILE);
    this.tileMax = new Float32Array(this.tilesX * this.tilesY);
    this.clear();
  }

  clear(): void {
    this.depth.fill(Infinity);
    this.tileMax.fill(Infinity);
    this.occludersDrawn = 0;
    this.tested = 0;
    this.culled = 0;
    this.dirtyTiles = false;
  }

  /**
   * 把一個**確定在物體內部**的盒子畫進去當遮蔽物。
   *
   * 盒子必須是內接的（整個在實體內部）。給外接盒的話它會擋掉物體其實遮不到
   * 的東西，而症狀是畫面邊緣的東西一閃一閃地消失。
   *
   * @param corners 8 個角的裁剪空間座標，每個角 4 個分量（x, y, z, w），
   *   順序是 `x + 2y + 4z`。由呼叫端算好 —— 它已經有矩陣了。
   * @returns 有沒有真的畫進去。跨過近平面或完全在畫面外的會被跳過。
   */
  addOccluder(corners: Float32Array): boolean {
    // 近平面後面的角一律放棄整個盒子。做裁剪要新增頂點，而那份程式碼的錯誤
    // 方向是「多擋住東西」—— 不值得為一個遮蔽物冒那個險。
    for (let i = 0; i < 8; i++) {
      if (corners[i * 4 + 3]! <= 1e-4) return false;
    }

    for (let i = 0; i < 8; i++) {
      const w = corners[i * 4 + 3]!;
      this.sx[i] = ((corners[i * 4]! / w) * 0.5 + 0.5) * this.width;
      this.sy[i] = ((corners[i * 4 + 1]! / w) * 0.5 + 0.5) * this.height;
    }

    // ## 真的把 12 個三角形畫進去，不是畫外接矩形
    //
    // 盒子斜著的時候在螢幕上是個六邊形，外接矩形比它大 —— 拿來當覆蓋範圍
    // 會擋掉角落其實看得見的東西。
    //
    // 第一版用「外接矩形往內縮 25%」當保守近似，而那個近似**把大部分遮蔽
    // 能力丟掉了**：兩個相鄰的遮蔽物之間會空出一條縫，合起來反而擋不住。
    // 測試裡「兩個各擋一半的合起來擋得住」那一條就是被它擋下來的。
    let drew = false;
    for (let f = 0; f < BOX_TRIANGLES.length; f += 3) {
      if (this.triangle(BOX_TRIANGLES[f]!, BOX_TRIANGLES[f + 1]!, BOX_TRIANGLES[f + 2]!, corners)) {
        drew = true;
      }
    }
    if (!drew) return false;

    this.occludersDrawn++;
    this.dirtyTiles = true;
    return true;
  }

  /**
   * 畫一個三角形，深度用三個頂點裡**最遠**的那個。
   *
   * w 在三角形上是投影插值的，而那種插值的極值一定落在頂點 —— 所以頂點的
   * 最大值就是整個三角形最遠的地方。那是保守的方向（門檻大 = 擋得少）。
   */
  private triangle(a: number, b: number, c: number, corners: Float32Array): boolean {
    const ax = this.sx[a]!;
    const ay = this.sy[a]!;
    const bx = this.sx[b]!;
    const by = this.sy[b]!;
    const cx = this.sx[c]!;
    const cy = this.sy[c]!;

    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    // 背面與退化的跳過。盒子是封閉的，朝著相機那三個面就蓋滿了輪廓。
    if (area <= 1e-9) return false;

    const w = Math.max(corners[a * 4 + 3]!, corners[b * 4 + 3]!, corners[c * 4 + 3]!);

    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5));
    const x1 = Math.min(this.width - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5));
    const y1 = Math.min(this.height - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
    if (x1 < x0 || y1 < y0) return false;

    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      const row = y * this.width;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        // 三條邊的符號一致就在裡面。像素中心取樣，邊緣不到一個像素的誤差
        // 由測試那一側往外擴一格吸收掉。
        if ((bx - ax) * (py - ay) - (by - ay) * (px - ax) < 0) continue;
        if ((cx - bx) * (py - by) - (cy - by) * (px - bx) < 0) continue;
        if ((ax - cx) * (py - cy) - (ay - cy) * (px - cx) < 0) continue;
        if (w < this.depth[row + x]!) this.depth[row + x] = w;
      }
    }
    return true;
  }

  /** 重算粗層。畫完遮蔽物、開始測之前呼叫一次。 */
  finish(): void {
    if (!this.dirtyTiles) return;
    this.dirtyTiles = false;
    this.tileMax.fill(-Infinity);
    for (let y = 0; y < this.height; y++) {
      const ty = (y / TILE) | 0;
      const row = y * this.width;
      const tileRow = ty * this.tilesX;
      for (let x = 0; x < this.width; x++) {
        const t = tileRow + ((x / TILE) | 0);
        const d = this.depth[row + x]!;
        if (d > this.tileMax[t]!) this.tileMax[t] = d;
      }
    }
  }

  /**
   * 這個盒子是不是**確定**被擋住。
   *
   * @param corners 8 個角的裁剪空間座標（與 `addOccluder` 同一個格式）。
   *   這裡可以放心用**外接**盒 —— 外接盒比物體大，要求它整個被擋住是
   *   更嚴格的條件，方向是安全的。
   * @returns true 代表可以安全剔除。不確定時一律回 false。
   */
  isOccluded(corners: Float32Array): boolean {
    this.tested++;
    if (this.occludersDrawn === 0) return false;

    let nearW = Infinity;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      const w = corners[i * 4 + 3]!;
      // 跨過近平面的東西一定有一部分在很近的地方，不剔。
      if (w <= 1e-4) return false;
      if (w < nearW) nearW = w;
      const x = ((corners[i * 4]! / w) * 0.5 + 0.5) * this.width;
      const y = ((corners[i * 4 + 1]! / w) * 0.5 + 0.5) * this.height;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    // ## 往外擴一個像素
    //
    // 遮蔽物是用像素中心蓋進去的，邊緣有不到一個像素的誤差。被測物的範圍
    // 往外擴一格，那個誤差就落在「要求更多像素都擋得住」的那一側 —— 也就是
    // 少剔一點。
    const x0 = Math.floor(minX) - 1;
    const x1 = Math.ceil(maxX) + 1;
    const y0 = Math.floor(minY) - 1;
    const y1 = Math.ceil(maxY) + 1;

    // 有任何一部分在畫面外就不剔 —— 畫面外沒有遮蔽物資料。
    if (x0 < 0 || y0 < 0 || x1 >= this.width || y1 >= this.height) return false;

    // 先看粗層：方塊的最大門檻都比被測物的近點小的話，整塊都擋得住。
    const tx0 = (x0 / TILE) | 0;
    const tx1 = (x1 / TILE) | 0;
    const ty0 = (y0 / TILE) | 0;
    const ty1 = (y1 / TILE) | 0;
    let allTilesOcclude = true;
    for (let ty = ty0; ty <= ty1 && allTilesOcclude; ty++) {
      const tileRow = ty * this.tilesX;
      for (let tx = tx0; tx <= tx1; tx++) {
        if (this.tileMax[tileRow + tx]! >= nearW) {
          allTilesOcclude = false;
          break;
        }
      }
    }
    if (allTilesOcclude) {
      this.culled++;
      return true;
    }

    // 粗層說不準就逐像素看。**一個擋不住就整個不剔**。
    for (let y = y0; y <= y1; y++) {
      const row = y * this.width;
      for (let x = x0; x <= x1; x++) {
        if (this.depth[row + x]! >= nearW) return false;
      }
    }
    this.culled++;
    return true;
  }
}
