import { Vector3 } from 'three';
import type { Camera, Object3D } from 'three';

/**
 * 大世界的座標精度：把世界平移回相機腳下。
 *
 * ## 為什麼非做不可（這不是「還能更好」）
 *
 * `Float32Array` 只有 24 位有效位數。離原點越遠，兩個可以表示的座標之間的
 * 間距越大：
 *
 * | 離原點 | float32 的間距 |
 * | ---: | ---: |
 * | 1,000 | 0.00006 |
 * | 10,000 | 0.001 |
 * | 100,000 | 0.008 |
 * | 1,000,000 | 0.06 |
 *
 * 而 instance 的矩陣就是存在 `Float32Array` 裡的。走到十萬單位外，一個
 * 公分級的細節就開始塌陷 —— 兩個相距 5 公釐的東西會擠到同一個座標上。
 *
 * 症狀是**畫面在抖**（相機一動，頂點就在可表示的格點之間跳），而且離原點
 * 越遠越嚴重。它不會報錯，也不會出現在任何幀時間指標上。
 *
 * ## 做法：把世界搬過來，而不是把數字變大
 *
 * 沒有辦法讓 float32 變精確，但可以讓座標**變小**。相機走遠到一個門檻時，
 * 把整個世界平移 `-offset`，相機也平移 `-offset` —— 相對關係完全不變，而
 * 所有座標都回到原點附近。
 *
 * UE 的解法是 Large World Coordinates（世界座標改成 double）。瀏覽器這邊
 * 走不了那條路：`Float32Array` 是 GPU 要的格式，不是我們選的。所以用平移。
 *
 * ## 邊界：只搬「交給套件的東西」
 *
 * 這個套件不碰使用者自己的 `Object3D`（見 doctrine 的分界線）。自動去搬
 * 整個 scene 就是「魔法加速器」——它得猜哪些東西屬於世界、哪些是 HUD 或
 * 貼在相機上的東西，而猜錯的症狀是東西跑掉。
 *
 * 所以這裡搬的是：**套件自己管的 instance 矩陣，加上呼叫端明確交出來的相機**。
 * 其餘的透過 `onRebase` 通知，由呼叫端自己處理 —— 那一行是明寫的，不是猜的。
 */

/** 可以被平移的東西。`InstancedMesh` 家族都實作它。 */
export interface Rebasable {
  /** 把所有 instance 的位置平移 `offset`。 */
  translateInstances(offset: Vector3): void;
}

export interface OriginRebaseOptions {
  /**
   * 相機離目前原點多遠就重定位，世界單位。
   *
   * ## 為什麼預設是 4096
   *
   * 這個數字是從**精度**推出來的，不是隨手訂的：float32 在 4,096 附近的
   * 間距是 0.00024（約 0.24 公釐）。也就是說在門檻內，最差的解析度仍然
   * 是次公釐級 —— 對任何肉眼尺度的內容都夠。
   *
   * 調大會省下重定位的次數（那是一次全部矩陣重寫），代價是遠端的精度。
   * 一樣的算法可以自己推：間距約等於 `距離 × 2⁻²³`。
   */
  threshold?: number;
  /**
   * 重定位發生時通知。`offset` 是**世界被平移了多少**（也就是所有東西
   * 都被加上這個向量）。
   *
   * 呼叫端要在這裡把自己的東西一起搬：光源、你自己的 mesh、物理世界的
   * 剛體、任何存著世界座標的資料。
   *
   * **不搬的症狀是那些東西相對世界跳掉一大段**，很明顯，所以這是一個
   * 會被立刻發現的錯 —— 這是刻意的，比靜靜地精度變差好。
   */
  onRebase?: (offset: Vector3) => void;
}

/**
 * 世界原點的狀態機。
 *
 * 它自己不知道有哪些東西要搬 —— 呼叫端註冊。這樣 `World` 不必認識
 * `InstancedMesh` 以外的型別，之後物理那一層也能用同一個介面掛進來。
 */
export class OriginRebase {
  private readonly targets = new Set<Rebasable>();
  private readonly _origin = new Vector3();
  private readonly offset = new Vector3();
  private readonly threshold: number;
  /** 門檻的平方。每幀比一次，開平方是白花的。 */
  readonly thresholdSq: number;
  private readonly onRebase: ((offset: Vector3) => void) | undefined;
  private _count = 0;

  constructor(options: OriginRebaseOptions = {}) {
    this.threshold = options.threshold ?? 4096;
    this.thresholdSq = this.threshold * this.threshold;
    this.onRebase = options.onRebase;
  }

  /**
   * 目前的原點在**真正的世界座標**裡的哪裡。
   *
   * 場景裡的座標加上這個值才是世界座標。存檔、跨 session 的定位、與伺服器
   * 對齊都要用它 —— 沒有它的話重定位之後「這個東西在世界的哪裡」就答不出來了。
   */
  get origin(): Vector3 {
    return this._origin;
  }

  /** 重定位過幾次。 */
  get count(): number {
    return this._count;
  }

  add(target: Rebasable): void {
    this.targets.add(target);
  }

  remove(target: Rebasable): void {
    this.targets.delete(target);
  }

  /**
   * 相機走遠了就把世界搬回來。每幀呼叫，通常什麼都不做。
   *
   * @returns 這一次有沒有真的搬。
   */
  update(camera: Camera): boolean {
    const at = camera.position;
    if (at.lengthSq() < this.thresholdSq) return false;

    // ## 平移量取整到 1 單位，不是直接用相機位置
    //
    // 用相機位置的話每次重定位都會落在一個任意的小數上，而那個小數本身
    // 就帶著誤差 —— 搬過幾次之後，累積的偏移會讓「場景座標 + origin」
    // 算回世界座標時對不上。
    //
    // 取整之後每一次平移都是**可以被 float32 精確表示的整數**，所以
    // `origin` 是精確的，累積多少次都不會漂。
    this.offset.set(-Math.round(at.x), -Math.round(at.y), -Math.round(at.z));
    this._origin.sub(this.offset);

    for (const target of this.targets) target.translateInstances(this.offset);
    camera.position.add(this.offset);
    camera.updateMatrixWorld(true);

    this._count++;
    this.onRebase?.(this.offset);
    return true;
  }
}

/**
 * 一個 `Object3D` 的位置平移 `offset`。
 *
 * 給 `onRebase` 裡搬自己東西的呼叫端用 —— 光源、地標、任何存著世界座標的
 * `Object3D`。寫成函式是因為「要記得 `updateMatrixWorld`」這件事會被忘記，
 * 而忘記的症狀是那個物件晚一幀才跳過去。
 */
export function translateObject(object: Object3D, offset: Vector3): void {
  object.position.add(offset);
  object.updateMatrixWorld(true);
}
