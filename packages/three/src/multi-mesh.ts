import { BatchedMesh, Matrix4, Sphere, Vector2, Vector3 } from 'three';
import type { BufferGeometry, Camera, Group, Material, Scene, WebGLRenderer } from 'three';
import { isLodChain, pixelsPerUnit, selectLevel, type GeometrySource } from './lod-chain.ts';

/**
 * 一堆**各自不同**的幾何，一次繪製，逐塊選階與剔除。
 *
 * ## 它補的洞
 *
 * `InstancedMesh(geometry, material, count)` 的前提是**所有 instance 共用同一份
 * 幾何**。那涵蓋了「很多顆一樣的石頭」，但涵蓋不了：
 *
 * - **大地表**：每一塊的高度都不一樣，是 N 份相異的幾何
 * - **掃描的建物、城市**：同一個東西橫跨很大的深度範圍
 *
 * 那兩種內容的共同點是**跨越很大的深度範圍**：腳下清清楚楚、地平線那端只有
 * 幾個像素，而它們屬於同一個東西。整個丟成一份幾何的話，選階被最近的那一塊
 * 綁死，遠處那些也跟著畫最細的。
 *
 * ## 值多少（實測）
 *
 * 420 萬個三角形的程序化地形，總三角形數固定，相機貼著地面看地平線。整片
 * 一份幾何是 **11.606 ms**：
 *
 * | 分塊 | 一塊一個物件 | MultiMesh |
 * | --- | ---: | ---: |
 * | 8×8 | 7.953 ms（51 次繪製） | 7.601 ms（3 次） |
 * | 16×16 | 7.899 ms（173 次） | 6.462 ms（3 次） |
 * | 32×32 | **11.257 ms**（647 次） | **5.253 ms**（3 次） |
 *
 * 重點在 32×32 那一列：**一塊一個物件時，分更細反而變慢**（比 16×16 差，
 * 甚至追平整片一份幾何）—— 繪製呼叫把剔除省下來的又吃回去了。
 *
 * MultiMesh 把繪製次數釘在 3，所以分越細越賺。對整片一份幾何是 **省 54.7%**，
 * 而「一塊一個物件」那條路的天花板只到 32.9%。
 *
 * **這個類別真正解掉的是那個天花板，不是分塊本身。** 分塊用 `THREE.Group`
 * 加一堆 Mesh 就做得到，而那條路在 647 次繪製的地方撞牆。
 *
 * ## 內容不夠大的時候它沒有價值
 *
 * 同樣的實驗在 52 萬個三角形上，分到 16×16 只省 2.2% —— 那份內容對一張桌機
 * GPU 只值 2.7 ms，分太細就被繪製呼叫吃掉。這不是「分塊沒用」，是「那份內容
 * 本來就不痛」。見 doctrine.md 第 12 條。
 *
 * ## 為什麼是一個新類別而不是擴充 InstancedMesh
 *
 * `InstancedMesh` 的逐幀迴圈是這個套件最熱、也最怕出錯的一段（剔除錯了不會
 * 報錯，只會偶爾破洞）。為了一個不同形狀的需求去在那裡加一層 indirection，
 * 風險與收益不成比例。
 *
 * 這個類別完全走 `BatchedMesh` 的公開介面 —— `addGeometry`、`addInstance`、
 * `setGeometryIdAt` —— 所以剔除與繪製合併是 Three 自己做的，而
 * `InstancedMesh` 那條路一行都沒有動到。
 *
 * ## 它不做什麼
 *
 * - **不做遠景合併**：那是「很多個小東西各付一次繪製」的解法，而這裡每一塊
 *   本來就大。
 * - **不自動產生 LOD**：每一塊的鏈由呼叫端給（`{ lods, errors }`），因為
 *   N 份相異幾何各自跑一次簡化是一筆很大的啟動成本，該不該付是呼叫端的事。
 *   只給一份幾何的塊就是單一階，照樣有剔除。
 */

/** 一塊的內部狀態。 */
interface Piece {
  /** 每一階在批次裡的 geometry id，index 0 最細。 */
  ids: number[];
  errors: Float32Array;
  /** 第 0 階的包圍球半徑，用來把 instance 的縮放換算回來。 */
  baseRadius: number;
  /** 第 0 階的包圍球心，區域座標。 */
  center: Vector3;
  /** 這一塊在批次裡的 instance id。 */
  instanceId: number;
}

export interface MultiMeshOptions {
  /**
   * 品質契約：被選中的階，幾何誤差投影到螢幕上不超過幾像素。預設 2。
   *
   * 與 `InstancedMesh` 同一個意思、同一個預設 —— 兩邊對「畫質」的定義必須
   * 一樣，不然同一個場景裡兩種物件會用不同的標準，而那是看不出來的。
   */
  errorPixels?: number;
}

export class MultiMesh extends BatchedMesh {
  private readonly pieces: Piece[] = [];
  private readonly errorPixels: number;
  private readonly _levelCounts: number[] = [];

  constructor(
    sources: readonly GeometrySource[],
    material: Material,
    options: MultiMeshOptions = {},
  ) {
    if (sources.length === 0) {
      throw new Error('WW.MultiMesh: sources 是空的。至少要有一塊幾何。');
    }

    // `BatchedMesh` 要求一開始就給總量，所以先把每一塊的每一階加起來。
    let vertexBudget = 0;
    let indexBudget = 0;
    for (const source of sources) {
      for (const geometry of levelsOf(source)) {
        vertexBudget += geometry.getAttribute('position')!.count;
        indexBudget += geometry.getIndex()?.count ?? 0;
      }
    }

    super(sources.length, vertexBudget, Math.max(indexBudget, 1), material);
    this.errorPixels = options.errorPixels ?? 2;

    // 物件層級的視錐剔除要關掉，理由與 `InstancedMesh` 相同：`BatchedMesh`
    // 的 `boundingSphere` **只算一次然後永遠快取**，而這裡的內容會動。
    // 逐塊的剔除由 `perObjectFrustumCulled` 負責，那個是每幀重算的。
    this.frustumCulled = false;

    const sphere = new Sphere();
    for (const source of sources) {
      const levels = levelsOf(source);
      const ids = levels.map((geometry) => this.addGeometry(geometry));

      const finest = levels[0]!;
      finest.computeBoundingSphere();
      sphere.copy(finest.boundingSphere!);

      this.pieces.push({
        ids,
        errors: errorsOf(source, levels.length),
        baseRadius: sphere.radius,
        center: sphere.center.clone(),
        instanceId: this.addInstance(ids[0]!),
      });
    }
  }

  /** 共幾塊。 */
  get pieceCount(): number {
    return this.pieces.length;
  }

  // 這裡**沒有** `visibleCount`，而那是刻意的。
  //
  // 逐塊的視錐剔除是 `BatchedMesh` 在 `perObjectFrustumCulled` 裡自己做的，
  // 發生在這個類別看不到的地方。第一版曾經有一個 `visibleCount`，而它其實
  // 是「總塊數」—— 每一塊都數，因為這裡根本不知道誰被剔掉了。
  //
  // 一個叫 visibleCount 但回傳總數的欄位比沒有更糟：它看起來像剔除沒生效，
  // 或是像剔除生效了但沒省 —— 兩個結論都是錯的，而且都會讓人去查錯地方。
  // 要看真的畫了幾次，用 `renderer.info.render.calls`。

  /** 這一幀每一階各被選中幾次。`index 0` 是最細的。 */
  get levelCounts(): readonly number[] {
    return this._levelCounts;
  }

  /**
   * 第 `piece` 塊的世界矩陣。
   *
   * 這是 `BatchedMesh.setMatrixAt` 的轉接 —— 塊的編號與 instance 的編號現在
   * 一樣，但把它包起來，之後若改成一塊多個 instance 也不會動到呼叫端。
   */
  setPieceMatrixAt(piece: number, matrix: Matrix4): this {
    this.setMatrixAt(this.pieces[piece]!.instanceId, matrix);
    return this;
  }

  getPieceMatrixAt(piece: number, target: Matrix4): Matrix4 {
    return this.getMatrixAt(this.pieces[piece]!.instanceId, target);
  }

  override onBeforeRender(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: Camera,
    geometry: BufferGeometry,
    material: Material,
    group: Group,
  ): void {
    const ppu = pixelsPerUnitFor(renderer, camera);
    if (ppu === null) {
      // 選不了階也要照畫 —— 正交相機沒有「每單位幾像素」這回事，但它的內容
      // 仍然要出現。直接 return 的話畫面全空。
      super.onBeforeRender(renderer, scene, camera, geometry, material, group);
      return;
    }

    _cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this._levelCounts.length = 0;

    for (const piece of this.pieces) {
      this.getMatrixAt(piece.instanceId, _matrix);
      // 世界空間的中心與縮放。縮放取三軸最大 —— 保守的方向（誤差算得偏大，
      // 於是挑到較細的階），而反過來是靜靜違反品質契約。
      _center.copy(piece.center).applyMatrix4(_matrix).applyMatrix4(this.matrixWorld);
      const scale = maxAxisScale(_matrix) * maxAxisScale(this.matrixWorld);

      const distance = Math.max(
        _cameraPosition.distanceTo(_center) - piece.baseRadius * scale,
        1e-6,
      );
      // 與 `InstancedMesh` 完全同一條式子：誤差 × (縮放 ÷ 距離) × 每單位像素。
      const perMetre = (scale / distance) * ppu;
      const level = selectLevel(piece.errors, perMetre, this.errorPixels);

      this.setGeometryIdAt(piece.instanceId, piece.ids[level]!);
      while (this._levelCounts.length <= level) this._levelCounts.push(0);
      this._levelCounts[level]!++;
    }

    // ## 一定要往上呼叫，而且要在選完階之後
    //
    // `BatchedMesh.onBeforeRender` **就是**做逐塊剔除、排序、以及組出
    // multi-draw 清單的地方。不呼叫它的話畫面上一個三角形都不會出現。
    //
    // 而那個症狀非常會騙人：沒有錯誤、沒有警告，**而且幀時間好得不得了**
    // ——第一版量到 1.589 ms 對 7.998 ms，看起來像 5 倍的勝利，實際上是
    // 什麼都沒畫。三角形數印出來才看得到（546 個，全是場景裡別的東西）。
    //
    // 順序也不能換：選階要先寫進 `setGeometryIdAt`，父類別才會拿新的幾何
    // 去算包圍盒與繪製範圍。
    super.onBeforeRender(renderer, scene, camera, geometry, material, group);
  }
}

const _matrix = /*@__PURE__*/ new Matrix4();
const _center = /*@__PURE__*/ new Vector3();
const _cameraPosition = /*@__PURE__*/ new Vector3();

function maxAxisScale(matrix: Matrix4): number {
  const e = matrix.elements;
  const x = Math.hypot(e[0]!, e[1]!, e[2]!);
  const y = Math.hypot(e[4]!, e[5]!, e[6]!);
  const z = Math.hypot(e[8]!, e[9]!, e[10]!);
  return Math.max(x, y, z);
}

function levelsOf(source: GeometrySource): BufferGeometry[] {
  return isLodChain(source) ? [...source.lods] : [source];
}

function errorsOf(source: GeometrySource, count: number): Float32Array {
  if (!isLodChain(source)) return new Float32Array(1);
  const errors = Float32Array.from(source.errors);
  if (errors.length !== count) {
    throw new Error(
      `WW.MultiMesh: 某一塊的 errors 有 ${errors.length} 筆、lods 有 ${count} 階，數量必須相同。`,
    );
  }
  if (errors[0] !== 0) {
    throw new Error(`WW.MultiMesh: 某一塊的 errors[0] 必須是 0，收到 ${errors[0]}。`);
  }
  return errors;
}

/**
 * 現在畫到哪裡就用哪裡的高度。
 *
 * 與 `InstancedMesh` 一樣要問 render target 而不是畫布 —— 後處理與 shadow map
 * 都是畫到離屏的 target 上，尺寸不同，用畫布的高度會讓選階整組偏掉。
 */
function pixelsPerUnitFor(renderer: WebGLRenderer, camera: Camera): number | null {
  const perspective = camera as Camera & { isPerspectiveCamera?: boolean; fov?: number };
  if (perspective.isPerspectiveCamera !== true || perspective.fov === undefined) return null;
  const target = renderer.getRenderTarget();
  const height = target === null ? renderer.getDrawingBufferSize(_size).y : target.height;
  return pixelsPerUnit(height, (perspective.fov * Math.PI) / 180);
}

const _size = /*@__PURE__*/ new Vector2();
