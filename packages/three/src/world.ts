import { Vector3, type Camera, type Object3D } from 'three';
import { InstancedMesh } from './instanced-mesh.ts';
import { WorldStream, type StreamOptions } from './streaming.ts';

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

  constructor(scene: Object3D) {
    this.scene = scene;
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
