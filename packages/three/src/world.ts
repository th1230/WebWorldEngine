import { Vector3, type Camera, type Object3D, type Scene, type WebGLRenderer } from 'three';
import { SceneDepthNormals, type SceneDepthNormalsOptions } from './depth-normals.ts';
import { InstancedMesh } from './instanced-mesh.ts';
import { OriginRebase, type OriginRebaseOptions } from './origin.ts';
import { WorldStream, type StreamOptions } from './streaming.ts';

/** 沒開重定位時 `origin` 回傳的常數。不配置新物件，也改不壞。 */
const ORIGIN_ZERO = Object.freeze(new Vector3()) as Vector3;

/**
 * 一個 scene 上的共用上下文。
 *
 * ## 為什麼它是「發現」的而不是「要求」的
 *
 * 每一句「你要先做 A B C，D 才會有效」都是負擔，而這個專案存在的理由
 * 就是替開發者省掉那些。所以單一物件的能力（剔除、LOD）**沒有任何前置**
 * —— `WW.InstancedMesh` 是個 `Object3D`，加進 scene 就運作，不需要 world。
 *
 * 只有真正跨物件的東西才需要共用上下文：統計要橫跨整個 scene，串流要
 * 知道整個世界的格局。那時才呼叫 `worldFor(scene)`。
 *
 * ## 為什麼掛在 scene 上而不是全域
 *
 * 全域狀態會讓「同一頁有兩個獨立的 3D 區塊」壞掉，而網站正是最常出現
 * 那種形態的地方。掛在 scene 上，多個 scene 自然各有各的。
 */
export class World {
  readonly scene: Object3D;

  private _stream: WorldStream | null = null;
  private _origin: OriginRebase | null = null;

  /** 這一幀共用的深度與法線。第一個要的人觸發，其餘的人拿同一份。 */
  private _depthNormals: SceneDepthNormals | null = null;
  private _depthNormalsOptions: SceneDepthNormalsOptions = {};
  private _frame = 0;
  private _depthNormalsFrame = -1;
  private _beganFrame = false;
  private _warnedNoBeginFrame = false;

  constructor(scene: Object3D) {
    this.scene = scene;
  }

  /**
   * 告訴這個 world：新的一幀開始了。
   *
   * ## 為什麼需要這一行
   *
   * 螢幕空間的那幾個效果（接觸陰影、距離場陰影、體積霧、追蹤反射、虛擬
   * 陰影圖）共用同一張深度法線圖。共用的東西**一幀只該算一次**，而
   * 「一幀」是應用層的概念 —— 套件從外面看不到它。
   *
   * 先前的做法是把那張圖交給呼叫端：自己 new、自己每幀 update、自己傳給
   * 每一個效果。那有三個代價，而第三個最貴：
   *
   * 1. 使用者要知道一個他不關心的東西存在
   * 2. 順序錯了不會報錯
   * 3. **套件只能用猜的** —— `isFresh` 原本是
   *    `renderer.info.render.frame - stamp <= 8`，那個 8 是因為每個效果
   *    自己的 pass 也會讓幀號前進，所以無法要求相等
   *
   * 有了這一行，「新不新」變成確定的：這一幀叫過就是新的。
   *
   * ## 它不接管繪製
   *
   * 這裡只推進一個計數器。什麼時候畫、畫什麼、後處理怎麼接，全部還是
   * 呼叫端的事 —— 見 ADR-0001 與 `specs/api.md` 第一節。
   *
   * ```js
   * const world = WW.worldFor(scene);
   * function frame() {
   *   world.beginFrame();
   *   const shadow = contact.render(renderer, scene, camera, { lightDirection });
   *   renderer.render(scene, camera);
   * }
   * ```
   */
  beginFrame(): void {
    this._beganFrame = true;
    this._frame++;
  }

  /**
   * 調整那張共用圖怎麼畫。**在第一次繪製之前叫**，之後叫會重建它。
   *
   * 預設是半解析度（`scale: 0.5`）—— 那幾個效果吃的都是低頻的東西，半解析度
   * 看不出差別而成本是四分之一。要更銳利的接觸陰影就調到 1。
   *
   * ## 為什麼是設定而不是參數
   *
   * 這張圖是**共用**的。做成 `depthNormals(renderer, camera, options)` 的話
   * 就變成「第一個要它的效果說了算」，而那個順序是隱含的 —— 換個效果的呼叫
   * 順序，解析度就跟著變，且不會報錯。設定跟每幀的事分開就沒有這個問題。
   */
  setDepthNormals(options: SceneDepthNormalsOptions): void {
    this._depthNormalsOptions = options;
    this._depthNormals?.dispose();
    this._depthNormals = null;
    this._depthNormalsFrame = -1;
  }

  /**
   * 這一幀共用的深度與法線圖。**效果自己來拿，呼叫端不必知道它存在。**
   *
   * 一幀只會真的畫一次：第一個要的人觸發，後面的人拿到同一份。
   *
   * 沒有呼叫過 `beginFrame` 的話這裡每次都會重畫 —— 那是**正確但浪費**的
   * 退路（畫面對，只是同一張圖一幀畫了好幾次）。會講一次，因為那個浪費
   * 從外面看不出來。
   */
  depthNormals(renderer: WebGLRenderer, camera: Camera): SceneDepthNormals {
    this._depthNormals ??= new SceneDepthNormals(this._depthNormalsOptions);
    if (!this._beganFrame) {
      if (!this._warnedNoBeginFrame) {
        this._warnedNoBeginFrame = true;
        console.warn(
          [
            'WW.World: 沒有呼叫 beginFrame()，所以共用的深度法線圖每個效果各畫了一次。',
            '畫面是對的，只是同一張圖一幀畫了好幾次 —— 那個浪費從外面看不出來。',
            '在每幀的開頭加一行 WW.worldFor(scene).beginFrame() 就好。',
          ].join('\n'),
        );
      }
      this._depthNormals.update(renderer, this.scene as Scene, camera);
      return this._depthNormals;
    }
    if (this._depthNormalsFrame !== this._frame) {
      this._depthNormalsFrame = this._frame;
      this._depthNormals.update(renderer, this.scene as Scene, camera);
    }
    return this._depthNormals;
  }

  /**
   * 開啟大世界的原點重定位。
   *
   * ## 為什麼是「開」的而不是預設
   *
   * 跨過門檻的那一幀要重寫**所有** instance 的矩陣。對一個只在原點附近
   * 幾百單位的場景那是純粹的浪費 —— 而多數 Three.js 專案是那樣的。
   *
   * 反過來，做大世界的人不開它就一定會撞到精度塌陷，所以它也不能藏起來。
   * 這是準則的「可以宣告的就要求宣告」：世界有多大只有你知道。
   *
   * 開了之後每幀呼叫 `updateOrigin(camera)`，並在 `onRebase` 裡把**自己的**
   * 東西一起搬（光源、你自己的 mesh、物理剛體、任何存著世界座標的資料）。
   */
  rebaseOrigin(options: OriginRebaseOptions = {}): OriginRebase {
    this._origin ??= new OriginRebase(options);
    return this._origin;
  }

  /**
   * 相機走遠了就把世界搬回它腳下。每幀呼叫，通常什麼都不做。
   *
   * 場景裡的 `WW.InstancedMesh` **會自己被找到**，不必註冊 —— 那是這個套件
   * 的基本承諾（加進 scene 就運作）。要求逐一註冊的話，漏掉一個的症狀是
   * 那一批東西整個跳走，而且是在走遠之後才發生。
   */
  updateOrigin(camera: Camera): boolean {
    const rebase = this._origin;
    if (rebase === null) return false;
    // 走訪只在真的要搬的那一幀做。平常這裡就只是一次長度平方的比較。
    if (camera.position.lengthSq() < rebase.thresholdSq) return false;

    this.scene.traverse((object) => {
      if (object instanceof InstancedMesh) rebase.add(object);
    });
    return rebase.update(camera);
  }

  /** 目前的原點在真正的世界座標裡的哪裡。沒開重定位就是零。 */
  get origin(): Vector3 {
    return this._origin?.origin ?? ORIGIN_ZERO;
  }

  /**
   * 開始串流：世界比記憶體大的時候，內容跟著相機載入卸載。
   *
   * ```js
   * WW.worldFor(scene).stream({
   *   cellSize: 200,
   *   radius: 700,
   *   load: (cx, cz) => [{ mesh: rocks, matrix: m }, …],
   * });
   * ```
   *
   * **不開串流時一切照常** —— 內容全部常駐，這個方法根本不必呼叫。
   * 那是「用了更好，不用也能動」在這一層的意思。
   *
   * ## 相機從哪裡來
   *
   * 掛在 `scene.onBeforeRender` 上。那是 Three.js 每次 render 都會呼叫的
   * 鉤子，參數就帶著相機 —— 不必要求使用者傳、也不必要求他每幀呼叫
   * `update()`。原本掛在上面的處理函式會被**接續呼叫**，不是覆蓋。
   */
  stream(options: StreamOptions): WorldStream {
    if (this._stream !== null) {
      throw new Error('WW: 這個 scene 已經在串流了。要換設定請先 stopStream()。');
    }

    const stream = new WorldStream(options);
    // 串流寫進來的矩陣要先減掉原點才轉成 float32 —— 見 `place` 那一段。
    // 用 getter 而不是傳值：原點會在重定位時改變，而串流是一直活著的。
    stream.useOrigin(() => this.origin);
    this._stream = stream;

    const previous = this.scene.onBeforeRender.bind(this.scene);
    this.scene.onBeforeRender = (...args: Parameters<Object3D['onBeforeRender']>): void => {
      previous(...args);
      if (this._stream !== stream) return;
      const camera = args[2] as Camera;
      _cameraWorld.setFromMatrixPosition(camera.matrixWorld);
      stream.update(_cameraWorld.x, _cameraWorld.z, performance.now());
    };

    return stream;
  }

  /** 停止串流。已經載入的內容留著 —— 卸載是使用者的決定，不是這裡的。 */
  stopStream(): void {
    this._stream = null;
  }

  get streaming(): WorldStream | null {
    return this._stream;
  }

  /**
   * 整個 scene 裡所有 `WW.*` 物件這一幀的加總。
   *
   * ## 為什麼要有這個
   *
   * 「剔除有沒有生效」在幀時間上看不出來 —— 沒生效，跟生效了但場景本來
   * 就全在畫面裡，兩者長得一模一樣。而引擎自己也不能因為數字難看就
   * 偷偷降級，那是開發者的政策。所以它把資訊交出去。
   *
   * 這是每次呼叫走訪一次場景圖，**不要每幀呼叫**。
   */
  get stats(): WorldStats {
    let objects = 0;
    let instances = 0;
    let visible = 0;
    let tested = 0;
    let cells = 0;
    let visibleCells = 0;
    let spatialObjects = 0;

    this.scene.traverse((object) => {
      if (!(object instanceof InstancedMesh)) return;
      const s = object.stats;
      objects++;
      instances += object.count;
      visible += s.visible;
      tested += s.tested;
      cells += s.cells;
      visibleCells += s.visibleCells;
      if (s.spatial) spatialObjects++;
    });

    return { objects, instances, visible, tested, cells, visibleCells, spatialObjects };
  }
}

export interface WorldStats {
  /** 這個 scene 裡有幾個 `WW.*` 物件。 */
  objects: number;
  /** 它們的 instance 總數。 */
  instances: number;
  /** 上一幀實際送去畫的 instance 數。 */
  visible: number;
  /** 上一幀真的被逐一測試過的 instance 數。`instances - tested` 就是空間分割省下的。 */
  tested: number;
  cells: number;
  visibleCells: number;
  /** 仍在用空間分割的物件數。小於 `objects` 代表有物件退回了逐一走訪。 */
  spatialObjects: number;
}

const _cameraWorld = new Vector3();

const worlds = new WeakMap<Object3D, World>();

/**
 * 取得（必要時建立）這個 scene 的共用上下文。
 *
 * 同一個 scene 重複呼叫回傳同一個 `World`。用 `WeakMap` 掛，所以 scene
 * 被回收時上下文跟著走 —— 不需要 `dispose()`，也不會有全域表越長越長。
 */
export function worldFor(scene: Object3D): World {
  let world = worlds.get(scene);
  if (world === undefined) {
    world = new World(scene);
    worlds.set(scene, world);
  }
  return world;
}
