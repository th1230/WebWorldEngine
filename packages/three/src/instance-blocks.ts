import type { Frustum } from './camera-frustum.ts';

/**
 * 串流寫進來的**區塊**：一段連續的 instance，加上它們的包圍球。
 *
 * ## 為什麼這東西存在
 *
 * 空間分割的重點是「一次剔掉一整群在一起的東西」。而串流**已經知道**哪些
 * 東西在一起了 —— 它就是照 cell 載入的，一次 `writeMatrices` 就是一格的
 * 內容，寫在一段連續的編號上。
 *
 * 原本的做法是把那個資訊丟掉，再用排序把它重建出來（`InstanceGrid`）。
 * 實測 490,000 個常駐 instance 時那次重建要 30 ms，而它省下的走訪是
 * 6.9 ms —— 帳算不過來，所以格子在串流全程幾乎是關著的。
 *
 * 區塊表不必重建：邊界在寫進來的當下就知道，包圍球在同一趟就順手算完
 * （那段記憶體本來就在手上）。每幀的成本是「測幾十個球」，不是
 * 「把幾十萬個重新排序」。
 *
 * ## 與 `InstanceGrid` 的分工
 *
 * | | 用哪個 |
 * | --- | --- |
 * | 內容是串流寫進來的（整段整段） | 區塊表 —— 分割是現成的 |
 * | 內容是使用者一個一個擺的 | 空間格 —— 沒有現成的分割，只能算 |
 *
 * 兩者互斥：只要有人用 `setMatrixAt` 動過區塊裡的東西，那個區塊的包圍球
 * 就過期了，整張表作廢，退回空間格。**過期的包圍球會讓一整塊憑空消失**，
 * 所以這裡寧可作廢也不猜。
 */
export class InstanceBlocks {
  /** 每一塊的 `[start, end)`，成對排列。 */
  private starts = new Int32Array(0);
  private ends = new Int32Array(0);
  /** 每一塊的包圍球：cx, cy, cz, radius。 */
  private spheres = new Float32Array(0);
  private _count = 0;
  /** 區塊有沒有完整覆蓋 `[0, instances)`。沒有就不能用它剔除。 */
  private covered = true;

  /**
   * 這一幀通過測試的區塊範圍，格式與 `InstanceGrid.update` 相同。
   *
   * 多一個 `inside`：那一段是不是**整段都在視錐內側**。是的話裡面每一個
   * instance 都必然可見，逐一測試那六個平面是純粹的白工。
   */
  private readonly visible: { bounds: Int32Array; count: number; inside: Uint8Array } = {
    bounds: new Int32Array(0),
    count: 0,
    inside: new Uint8Array(0),
  };

  get count(): number {
    return this._count;
  }

  /** 整張表作廢。有人用不是「整段寫入」的方式改過矩陣時呼叫。 */
  invalidate(): void {
    this._count = 0;
    this.covered = false;
  }

  /**
   * 記下一塊 `[start, start + length)`，並從矩陣算出它的包圍球。
   *
   * `baseRadius` 是單一 instance 未縮放時的包圍球半徑（已含球心偏移），
   * 與 `InstanceGrid.rebuild` 的同一個參數同義。
   */
  write(
    matrices: Float32Array,
    start: number,
    length: number,
    baseRadius: number,
  ): void {
    if (length <= 0) return;
    // 覆蓋在別的區塊上，或落在中間，都不是串流的形狀 —— 那時作廢。
    const at = this._count;
    if (at > 0 && this.ends[at - 1] !== start) {
      this.invalidate();
      return;
    }
    if (at === 0 && start !== 0) {
      this.invalidate();
      return;
    }

    if (at >= this.starts.length) this.grow();

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let maxScaleSq = 0;
    for (let i = start; i < start + length; i++) {
      const b = i * 16;
      const x = matrices[b + 12]!;
      const y = matrices[b + 13]!;
      const z = matrices[b + 14]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;

      // 三軸縮放取最大。這裡與包圍球快取用同一個保守取法 —— 兩邊不一致的
      // 話會出現「區塊說看不見、逐一說看得見」，而那就是破洞。
      const c0 = sq(matrices, b);
      const c1 = sq(matrices, b + 4);
      const c2 = sq(matrices, b + 8);
      const largest = c0 > c1 ? (c0 > c2 ? c0 : c2) : c1 > c2 ? c1 : c2;
      if (largest > maxScaleSq) maxScaleSq = largest;
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const dx = maxX - cx;
    const dy = maxY - cy;
    const dz = maxZ - cz;
    // **半徑要把 instance 自己的體積算進去。** 只包住平移點的話，邊緣那些
    // 物件會突出區塊外，而突出的部分會跟著整塊一起被剔掉 —— 症狀是畫面
    // 偶爾破洞，時間指標完全正常。
    const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) + baseRadius * Math.sqrt(maxScaleSq);

    this.starts[at] = start;
    this.ends[at] = start + length;
    this.spheres[at * 4] = cx;
    this.spheres[at * 4 + 1] = cy;
    this.spheres[at * 4 + 2] = cz;
    this.spheres[at * 4 + 3] = radius;
    this._count = at + 1;
    this.covered = true;
  }

  /**
   * 把 `[from, from + length)` 那一塊搬到 `to`。串流卸載時走這條。
   *
   * 只有整塊對整塊才處理得了 —— 對不上就作廢。串流本來就是整塊搬的
   * （`moveInstances` 的契約），對不上代表用法不是串流。
   */
  move(from: number, to: number, length: number): boolean {
    // 串流卸載的形狀是「把洞後面的**全部**往前挪」，不是「把最後一塊搬進洞」。
    // 所以 `[to, from)` 是被卸掉的那一塊，而它後面的每一塊整體往前移
    // `from - to`。裡面的相對位置沒變，包圍球也沒變 —— 只有編號變了。
    const delta = from - to;
    if (delta <= 0) {
      this.invalidate();
      return false;
    }
    let removed = -1;
    for (let i = 0; i < this._count; i++) {
      if (this.starts[i] === to && this.ends[i] === from) {
        removed = i;
        break;
      }
    }
    // 洞的邊界對不上任何一塊，或搬的長度與尾巴對不上 —— 那不是串流的形狀。
    if (removed < 0 || this.ends[this._count - 1]! !== from + length) {
      this.invalidate();
      return false;
    }

    for (let i = removed + 1; i < this._count; i++) {
      this.starts[i] = this.starts[i]! - delta;
      this.ends[i] = this.ends[i]! - delta;
    }
    this.remove(removed);
    return true;
  }

  /** 丟掉超出 `instances` 的區塊。串流縮小 count 時走這條。 */
  truncate(instances: number): void {
    while (this._count > 0 && this.ends[this._count - 1]! > instances) {
      if (this.starts[this._count - 1]! >= instances) {
        this._count--;
        continue;
      }
      // 一塊被切一半：包圍球不再正確，只能作廢。
      this.invalidate();
      return;
    }
  }

  /** 區塊有沒有剛好覆蓋 `[0, instances)`。沒有就不能拿來剔除。 */
  covers(instances: number): boolean {
    if (!this.covered || this._count === 0) return false;
    return this.starts[0] === 0 && this.ends[this._count - 1] === instances;
  }

  /**
   * 依視錐挑出看得見的區塊，回傳要走訪的範圍。
   *
   * 座標是 camera-relative 的，與 `Frustum` 一致。
   */
  update(
    frustum: Frustum,
    cameraX: number,
    cameraY: number,
    cameraZ: number,
  ): { bounds: Int32Array; count: number; inside: Uint8Array } {
    if (this.visible.bounds.length < this._count * 2) {
      this.visible.bounds = new Int32Array(this._count * 2);
      this.visible.inside = new Uint8Array(this._count);
    }
    const bounds = this.visible.bounds;
    const insideFlags = this.visible.inside;
    const planes = frustum.planes;
    const spheres = this.spheres;
    let out = 0;

    for (let i = 0; i < this._count; i++) {
      const s = i * 4;
      const cx = spheres[s]! - cameraX;
      const cy = spheres[s + 1]! - cameraY;
      const cz = spheres[s + 2]! - cameraZ;
      const radius = spheres[s + 3]!;
      // 一趟同時答兩件事：碰得到嗎（`>= -radius`），以及**整顆都在內側**嗎
      // （`>= +radius`）。後者讓走訪那一側可以整段跳過平面測試。
      let hit = true;
      let whole = true;
      for (let p = 0; p < 24; p += 4) {
        const d = planes[p]! * cx + planes[p + 1]! * cy + planes[p + 2]! * cz + planes[p + 3]!;
        if (d < -radius) {
          hit = false;
          break;
        }
        if (d < radius) whole = false;
      }
      if (!hit) continue;
      const flag = whole ? 1 : 0;
      // 相鄰的可見區塊併成一段，走訪那一側就少一次外層迴圈 —— 但只有
      // 內外側判斷相同時才併得起來，不然那一段的旗標就沒有意義了。
      if (out > 0 && bounds[out - 1] === this.starts[i] && insideFlags[out / 2 - 1] === flag) {
        bounds[out - 1] = this.ends[i]!;
        continue;
      }
      bounds[out] = this.starts[i]!;
      bounds[out + 1] = this.ends[i]!;
      insideFlags[out / 2] = flag;
      out += 2;
    }

    this.visible.count = out / 2;
    return this.visible;
  }

  private remove(index: number): void {
    const last = this._count - 1;
    for (let i = index; i < last; i++) {
      this.starts[i] = this.starts[i + 1]!;
      this.ends[i] = this.ends[i + 1]!;
      this.spheres.copyWithin(i * 4, (i + 1) * 4, (i + 1) * 4 + 4);
    }
    this._count = last;
  }

  private grow(): void {
    const size = Math.max(this.starts.length * 2, 64);
    const starts = new Int32Array(size);
    const ends = new Int32Array(size);
    const spheres = new Float32Array(size * 4);
    starts.set(this.starts);
    ends.set(this.ends);
    spheres.set(this.spheres);
    this.starts = starts;
    this.ends = ends;
    this.spheres = spheres;
  }
}

/** 4×4 矩陣某一欄（3 個分量）的長度平方。 */
function sq(m: Float32Array, at: number): number {
  const x = m[at]!;
  const y = m[at + 1]!;
  const z = m[at + 2]!;
  return x * x + y * y + z * z;
}
