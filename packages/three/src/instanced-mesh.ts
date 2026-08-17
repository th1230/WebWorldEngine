import {
  BatchedMesh,
  BufferAttribute,
  BufferGeometry as ThreeBufferGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  Matrix4,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Camera,
  type Material,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { createFrustum, frustumFromCamera, type Frustum } from './camera-frustum.ts';
import { InstanceGrid } from './instance-grid.ts';
import { pixelsPerUnit, resolveLodChain, selectLevel, type GeometrySource } from './lod-chain.ts';
import type {
  GeneratedLevel,
  GeometryData,
  LodGenerationOptions,
} from './lod-generation.ts';
import { requestLodLevels } from './lod-service.ts';
import { mergeInstances, mergedSize, placeholderLike } from './hlod.ts';
import { assertBatchedMeshInternals, type BatchedMeshInternals } from './three-internals.ts';

/** 自動產生 LOD 的成本拆解。 */
export interface LodStats {
  /** 最後總共有幾階。 */
  levels: number;
  /** 簡化本身花掉的時間。 */
  generationMs: number;
  /** 主執行緒真正付掉的部分：複製給 worker + 把結果接回批次幾何。 */
  mainThreadMs: number;
  /** false 代表 worker 不可用，整段跑在主執行緒上。 */
  offMainThread: boolean;
}

export interface InstancedMeshOptions {
  /**
   * 允許的螢幕誤差上限，像素。預設 2。
   *
   * 這是**品質契約**：無論 LOD 鏈做得多粗，被選中的階其幾何誤差投影到
   * 螢幕上都不會超過這個值。放寬它就是拿畫質換效能 —— 那是政策，
   * 屬於開發者，所以它是一個旋鈕而不是引擎自己調的東西。
   */
  errorPixels?: number;
  /**
   * 每個空間 cell 的目標 instance 數。預設 64。
   *
   * 越小則剔除越精細但 cell 測試次數越多。調它之前先看 `stats`。
   */
  instancesPerCell?: number;
  /**
   * 只給了一份幾何時，要不要在 worker 裡自動補上 LOD 鏈。預設 **true**。
   *
   * 關掉它的理由通常是「這個物件本來就只會近距離出現」或「幾何小到不值得」。
   * 關掉之後這個物件仍然有空間分割剔除。
   */
  autoLod?: boolean;
  /** 自動產生的參數。只在 `autoLod` 生效時有意義。 */
  lod?: LodGenerationOptions;
  /**
   * 遠景合併（HLOD）。預設 **true**。
   *
   * 一整格的 instance 都遠到會挑最粗階時，改送一次合併好的幾何。
   * 遠景幾乎不花三角形，成本全在「送出去」這件事上 —— 實測一次繪製
   * 167 ns，而一個遠景 instance 只有 4 個三角形。
   *
   * 關掉的理由通常是記憶體：合併等於把最粗階複製一份。
   */
  hlod?: boolean;
  /**
   * 遠景合併的記憶體預算，MB。預設 64。
   *
   * 超過就不啟用，並且在 console 說明為什麼。**這是旋鈕不是自動判斷** ——
   * 「多少記憶體算多」取決於這個網站還要放什麼，引擎不知道。
   */
  hlodBudgetMB?: number;
  /**
   * 一個合併槽位裝得下幾個 instance。預設是**最大那一格**（一格一個槽位）。
   *
   * 調小會得到更多槽位（同樣預算），代價是大格子被拆成幾次繪製。值不值得
   * 取決於格子大小的分佈 —— 一個離群的大格子會把每個槽位都撐大。
   */
  hlodSlotInstances?: number;
}

/**
 * 一格可以合併的遠景。
 *
 * 「可以合併」不等於「已經烘好」—— 烘好的幾何住在一個**固定大小的槽位池**
 * 裡，見 `HlodSlot`。沒拿到槽位的格子照原本逐 instance 送。
 */
interface HlodGroup {
  /** 這一格在 `grid.order` 裡的範圍。 */
  from: number;
  to: number;
  /** 目前佔用的槽位，`-1` 代表還沒烘。 */
  slot: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  /** 這一格裡最大的 instance 縮放。選階要用它，否則會太早合併。 */
  maxScale: number;
}

/**
 * 一個可重複使用的合併幾何槽位。
 *
 * ## 為什麼是池而不是一格一份
 *
 * 一次烘全部格子的話，記憶體需求等於**世界有多大**。實測一百萬個 instance
 * 有一萬五千多格，預算只放得下 3,378 格，於是其餘的整批掉回逐 instance 送。
 *
 * 但任何一刻真正需要合併幾何的只有**看得見的遠景** —— 那個數量由視野決定，
 * 與世界大小無關（一百萬個那一格實測是 3,378 格在用）。
 *
 * 所以配一池固定大小的槽位反覆換內容：`BatchedMesh.setGeometryAt` 可以就地
 * 替換一個已保留範圍裡的幾何，不會再配置。`addGeometry` 會重用 id 但**不會
 * 重用緩衝區空間**，所以刪掉再加是會漏的。
 */
interface HlodSlot {
  geometryId: number;
  instanceId: number;
  /** 合併幾何在批次索引緩衝裡的位置。 */
  start: number;
  count: number;
  /** 目前放的是哪一格，`-1` 代表空的。 */
  group: number;
  /** 最後一次被畫到的幀序號。回收時挑最舊的。 */
  lastUsed: number;
}

const _cameraLocal = new Vector3();
const _inverse = new Matrix4();
const _size = new Vector2();
const _hlodMatrix = new Matrix4();

/** 連續幾幀矩陣都在變就放棄空間格 —— 重建的成本會超過它省下的。 */
const DYNAMIC_THRESHOLD = 8;

/**
 * 一格少於這個數就不合併。
 *
 * 合併的收益是「省下的繪製次數」，成本是「複製一份幾何」。三個以下時
 * 前者太小而後者照付。
 */
const HLOD_MIN_INSTANCES = 4;

/**
 * 每幀花在烘合併幾何上的預算，毫秒。
 *
 * 烘一格要走過它每個 instance 的每個頂點。一次烘幾百格是一次明顯的卡頓，
 * 而那正好發生在相機剛轉過去的時候。
 *
 * **用時間而不是「幾格」當預算**：一格的成本差好幾個數量級（最粗階 4 個
 * 三角形對 3,258 個），而且不同機器差很多。固定格數在小內容上浪費、在大
 * 內容上爆掉 —— 那正是「作者在自己機器上調好」的那種常數。
 */
const HLOD_BAKE_BUDGET_MS = 2;

/** 自動 LOD 待補時，批次幾何要預留幾倍的空間。 */
const LOD_RESERVE = 2;

/**
 * `THREE.InstancedMesh` 的強化版：同樣的建構參數、同樣的方法，
 * 多了**依螢幕誤差選 LOD** 與**空間分割剔除**。
 *
 * ```js
 * - const rocks = new THREE.InstancedMesh(geometry, material, 10000);
 * + const rocks = new WW.InstancedMesh(geometry, material, 10000);
 *   for (let i = 0; i < 10000; i++) rocks.setMatrixAt(i, m);
 *   scene.add(rocks);
 * ```
 *
 * 沒有初始化步驟，沒有 `update()` 要呼叫 —— 它是一個 `Object3D`，
 * 加進場景就開始運作，相機從 `onBeforeRender` 拿。
 *
 * ## 為什麼底層是 `BatchedMesh` 而不是 `InstancedMesh`
 *
 * `InstancedMesh` 一次只能畫一份幾何，所以逐 instance 的 LOD 在它上面
 * 做不到 —— 那正是這個類別的主要價值。而且在它上面做剔除只能靠「把可見的
 * 矩陣壓到陣列前段再設 `count`」，那會**每幀重傳整個矩陣緩衝**（機制層的
 * 反例），還會讓使用者的索引 `i` 指向別人。
 *
 * `BatchedMesh` 的 indirect texture 讓繪製順序與資料位置解耦：剔除與選階
 * 只改一張小小的索引表，矩陣一個位元組都不必動。
 *
 * ## 與 `THREE.InstancedMesh` 不同的地方
 *
 * 刻意列出來，因為靜默的差異比明講的差異危險得多：
 *
 * | | 差異 |
 * | --- | --- |
 * | `.geometry` | 回傳**內部合併後**的幾何，不是你傳進來的那份。你的那份在 `.sourceGeometry` |
 * | `.isInstancedMesh` | **沒有**這個旗標（有 `.isBatchedMesh`）。靠它做分支的第三方程式碼會走另一條路 |
 * | `.count` | 可讀可寫，語意相同（只畫前 N 個），但它不影響已寫入的矩陣 |
 * | `.instanceMatrix` | 有，而且與內部儲存**共用同一塊記憶體**，所以 `needsUpdate = true` 一樣有效 |
 */
export class InstancedMesh extends BatchedMesh {
  /** 你傳進來的幾何（`lods` 的話是第 0 階）。`.geometry` 是內部合併後的版本。 */
  readonly sourceGeometry: BufferGeometry;

  /**
   * 與 `THREE.InstancedMesh.instanceMatrix` 對應的檢視。
   *
   * **它與內部的矩陣貼圖共用同一塊 `Float32Array`** —— 不是複本。所以
   * 直接寫 `instanceMatrix.array` 再設 `needsUpdate = true` 的既有寫法
   * 完全有效，而且不會多一次搬移。
   */
  get instanceMatrix(): InstancedBufferAttribute {
    return this._instanceMatrix;
  }

  private _instanceMatrix: InstancedBufferAttribute;

  /**
   * 自動產生 LOD 鏈完成（或確定不做）時 resolve。
   *
   * 平常不需要碰它 —— 鏈補上去之前物件照樣運作，只是一直用最細的幾何。
   * 測試與「載入完成才顯示」那種流程才需要等它。
   */
  readonly lodReady: Promise<void>;

  private readonly internals: BatchedMeshInternals;
  private lodErrors: Float32Array;
  /** 每一階在合併幾何裡的繪製範圍 `[start, count]`，成對排列。 */
  private lodRanges: Int32Array;
  /**
   * 最粗那一階的來源幾何。遠景合併要拿它去烘。
   *
   * 只留最粗的一階 —— 其餘的資料都已經在批次幾何裡，多留一份只是浪費。
   */
  private coarsestGeometry: BufferGeometry | null = null;
  private hlodGroups: HlodGroup[] | null = null;
  private hlodSlots: HlodSlot[] | null = null;
  /** 這一幀想合併但還沒烘好的格子。 */
  private hlodWanted: number[] = [];
  private frameIndex = 0;
  private readonly hlodEnabled: boolean;
  private readonly hlodBudgetBytes: number;
  private readonly hlodSlotInstances: number | null;
  private _mergedDraws = 0;
  private _mergedInstances = 0;
  private _hlodSlotCount = 0;
  private _hlodGroupCount = 0;
  private _hlodCellMax = 0;
  /** 每個 instance 的世界空間包圍球：cx, cy, cz, radius。 */
  private spheres = new Float32Array(0);
  private spheresDirty = true;
  private spheresCount = -1;
  /** 快取是照走訪順序排的嗎。格子停用時退回照編號排。 */
  private spheresByOrder = false;
  private readonly errorPixels: number;
  private readonly instancesPerCell: number;
  private readonly grid = new InstanceGrid();
  private readonly frustum: Frustum = createFrustum();
  private matricesArray: Float32Array;
  /** 單一 instance 的區域空間包圍球。 */
  private readonly boundsCenter = new Vector3();
  private readonly boundsRadius: number;
  /**
   * 從 instance 的**平移點**（而不是包圍球心）算起要涵蓋多遠。
   *
   * 空間格是依平移點分配 cell 的，但物件實際佔的位置是球心。球心偏離
   * 原點的幾何（例如整個模型都在 +Y）若只用半徑外擴，偏移的那一段就沒
   * 被算進去 —— 那正是「畫面偶爾破洞」那一類錯誤的來源。
   */
  private readonly gridRadius: number;

  /**
   * 要畫的 instance 數（前 `count` 個）。語意與 `THREE.InstancedMesh.count` 相同。
   *
   * 設定它是 O(1) 的 —— 只是縮小走訪範圍，不動任何矩陣。變更會在下一次
   * 繪製前被偵測到。
   *
   * （`THREE.Mesh` 本來就有這個欄位，語意是「這個 mesh 畫幾份」，而
   * `BatchedMesh` 的繪製路徑完全不看它 —— 除了 `count === 0` 時整個物件
   * 會被跳過，那正好與這裡的語意一致。）
   */
  override count: number;

  /** 目前配置得下多少 instance。串流會視需要長大。 */
  get capacity(): number {
    return this._capacity;
  }

  private _capacity: number;
  private lastCount = -1;
  private consecutiveInvalidations = 0;
  private dynamic = false;
  private warnedSingleLevel = false;
  private lastMatrixVersion = -1;

  private _visibleInstances = 0;
  private _testedInstances = 0;
  private _cpuMs = 0;
  private _gridMs = 0;
  private _collectMs = 0;
  private _bakeMs = 0;
  private _levelCounts: Int32Array;
  private _lodStats: LodStats | null = null;

  /**
   * @param source 一份 `BufferGeometry`，或一條 `{ lods, errors }` LOD 鏈。
   *   只給一份幾何是完全合法的 —— 那就沒有 LOD，剔除照常運作。
   * @param material 與 `THREE.InstancedMesh` 相同。
   * @param count instance 數上限。
   */
  constructor(
    source: GeometrySource,
    material: Material,
    count: number,
    options: InstancedMeshOptions = {},
  ) {
    const { geometries, errors, canAutoGenerate } = resolveLodChain(source);
    const autoLod = canAutoGenerate && options.autoLod !== false;
    const prepared = unifyIndexing(geometries, autoLod);

    let vertexBudget = 0;
    let indexBudget = 0;
    for (const geometry of prepared) {
      vertexBudget += geometry.getAttribute('position')!.count;
      indexBudget += geometry.getIndex()?.count ?? 0;
    }
    // 之後要塞進來的階需要空間。預設比例累加起來約 0.78 倍，留一倍是為了
    // 不必在鏈補上來的那一幀重新配置整個批次幾何。
    const reserve = autoLod ? LOD_RESERVE : 1;

    super(count, Math.ceil(vertexBudget * reserve), Math.max(Math.ceil(indexBudget * reserve), 1), material);

    this.sourceGeometry = geometries[0]!;
    this.lodErrors = errors;
    this.errorPixels = options.errorPixels ?? 2;
    this.instancesPerCell = options.instancesPerCell ?? 64;
    this.hlodEnabled = options.hlod !== false;
    this.hlodBudgetBytes = (options.hlodBudgetMB ?? 64) * 1048576;
    this.hlodSlotInstances = options.hlodSlotInstances ?? null;
    this._capacity = count;
    this.count = count;
    this._levelCounts = new Int32Array(prepared.length);

    // 自己做剔除與排序，所以要把 Three.js 的關掉 —— 否則兩邊都會走訪
    // 全部 instance，而我們的結果會被它覆蓋。
    this.perObjectFrustumCulled = false;
    this.sortObjects = false;

    this.internals = assertBatchedMeshInternals(this);

    this.lodRanges = new Int32Array(prepared.length * 2);
    let maxRadius = 0;
    for (let level = 0; level < prepared.length; level++) {
      const geometry = prepared[level]!;
      const id = this.addGeometry(geometry);
      const info = this.internals._geometryInfo[id]!;
      this.lodRanges[level * 2] = info.start;
      this.lodRanges[level * 2 + 1] = info.count;
      if (level === 0) {
        geometry.computeBoundingSphere();
        const sphere = geometry.boundingSphere!;
        this.boundsCenter.copy(sphere.center);
        maxRadius = sphere.radius;
      }
    }
    this.coarsestGeometry = prepared[prepared.length - 1]!;
    this.boundsRadius = maxRadius;
    this.gridRadius = this.boundsCenter.length() + maxRadius;

    // 全部 instance 一次配置好。`setMatrixAt` 要求 instance 已存在，而
    // 使用者換掉的那行 `new THREE.InstancedMesh(...)` 之後就直接開始寫。
    for (let i = 0; i < count; i++) this.addInstance(0);

    this.matricesArray = this.internals._matricesTexture.image.data as Float32Array;
    this._instanceMatrix = new InstancedBufferAttribute(
      this.matricesArray.subarray(0, count * 16),
      16,
    );
    this._instanceMatrix.setUsage(DynamicDrawUsage);

    // 用**使用者給的**那份去產生，不是補過索引的那份 —— 補上去的
    // 索引是 0,1,2,… 的假索引，熔接階段反而要把它拆掉重來。
    this.lodReady = autoLod
      ? this.buildLodChain(geometries[0]!, options.lod ?? {})
      : Promise.resolve();
    if (!autoLod && prepared.length === 1) this.warnSingleLevel();
  }

  /**
   * 在 worker 裡把 LOD 鏈補上，回來之後接進批次幾何。
   *
   * 期間物件**照常運作**，只是一直用最細的幾何 —— 那是安全的方向
   * （慢，但畫面正確）。
   */
  private async buildLodChain(
    geometry: BufferGeometry,
    options: LodGenerationOptions,
  ): Promise<void> {
    const copyStarted = performance.now();
    const source = toGeometryData(geometry);
    if (typeof source === 'string') {
      // 做不到就講清楚做不到什麼、為什麼、以及使用者可以怎麼辦。
      // 靜默退化成單一階會讓人以為自己在用強化版。
      console.info(
        `WW.InstancedMesh: 這份幾何不能自動產生 LOD（${source}），會一直用最細的幾何。\n` +
          '空間分割剔除照常運作。要 LOD 的話請自備 { lods: [細…粗], errors: [0, …] }。',
      );
      return;
    }

    const copiedMs = performance.now() - copyStarted;

    let timing;
    try {
      timing = await requestLodLevels(source, options);
    } catch (error) {
      console.warn(
        'WW.InstancedMesh: LOD 產生失敗，會一直用最細的幾何。',
        error instanceof Error ? error.message : error,
      );
      return;
    }

    if (timing.levels.length === 0) {
      console.info(
        'WW.InstancedMesh: 這份幾何簡化不下去（可能三角形本來就很少，或全是硬邊），' +
          '會一直用最細的幾何。空間分割剔除照常運作。',
      );
      return;
    }

    const appendStarted = performance.now();
    this.appendLodLevels(timing.levels);
    this._lodStats = {
      levels: this.lodErrors.length,
      generationMs: timing.elapsedMs,
      offMainThread: timing.offMainThread,
      // 主執行緒真正付掉的部分：複製一份幾何給 worker，加上把結果接回批次幾何。
      // 沒有分開量的話，「不卡主執行緒」這句話就沒有數字撐著。
      mainThreadMs: copiedMs + (performance.now() - appendStarted),
    };
  }

  /** 把產生好的階加進批次幾何，並擴充選階用的表。 */
  private appendLodLevels(levels: readonly GeneratedLevel[]): void {
    let neededVertices = 0;
    let neededIndices = 0;
    for (const level of levels) {
      neededVertices += level.attributes['position']!.array.length / 3;
      neededIndices += level.indices.length;
    }
    // 預留不夠就長大。這會重建批次幾何 —— 而它只裝**相異的幾何**（幾百到
    // 幾千個頂點），與 instance 數無關，所以成本可以忽略。
    if (neededVertices > this.unusedVertexCount || neededIndices > this.unusedIndexCount) {
      this.setGeometrySize(
        this.internals._maxVertexCount + neededVertices,
        this.internals._maxIndexCount + neededIndices,
      );
    }

    const base = this.lodErrors.length;
    const errors = new Float32Array(base + levels.length);
    errors.set(this.lodErrors);
    const ranges = new Int32Array((base + levels.length) * 2);
    ranges.set(this.lodRanges);

    for (const [offset, level] of levels.entries()) {
      const id = this.addGeometry(toBufferGeometry(level));
      const info = this.internals._geometryInfo[id]!;
      const slot = base + offset;
      ranges[slot * 2] = info.start;
      ranges[slot * 2 + 1] = info.count;
      errors[slot] = level.error;
    }

    this.lodErrors = errors;
    this.lodRanges = ranges;
    this._levelCounts = new Int32Array(errors.length);
    // 最粗的階換人了，遠景合併要拿新的去烘。
    const last = levels[levels.length - 1];
    if (last !== undefined) this.coarsestGeometry = toBufferGeometry(last);
    this.invalidateInstances();
  }

  /**
   * 這一幀的實際狀況。**沒有這個就沒辦法判斷剔除到底有沒有生效** ——
   * 而「沒生效」與「生效了但場景本來就全在畫面裡」在幀時間上長得一樣。
   */
  get stats(): {
    visible: number;
    tested: number;
    cells: number;
    visibleCells: number;
    levels: Int32Array;
    spatial: boolean;
    cpuMs: number;
    /** 這一幀有幾次繪製是整格合併的遠景。0 代表沒有生效。 */
    merged: number;
    /** 被那些合併涵蓋的 instance 數。`levels` 不含它們。 */
    mergedInstances: number;
    /**
     * `cpuMs` 的分項。加起來會略小於 `cpuMs`（差額是矩陣版本比對等雜項）。
     *
     * 分開報是必要的：三項的優化方向完全不同，加在一起看會修錯地方。
     */
    cpuParts: { grid: number; collect: number; bake: number };
    /**
     * 遠景合併的槽位數、可合併的格數、最大一格有幾個 instance。
     *
     * `slots` 接近 `groups` 代表預算夠；遠小於它代表調高 `hlodBudgetMB`
     * 會讓更多遠景變成一次繪製。
     */
    hlod: { slots: number; groups: number; cellMax: number };
  } {
    return {
      visible: this._visibleInstances,
      tested: this._testedInstances,
      cells: this.grid.cellCount,
      visibleCells: this.grid.visibleCells,
      levels: this._levelCounts,
      spatial: !this.dynamic,
      cpuMs: this._cpuMs,
      merged: this._mergedDraws,
      mergedInstances: this._mergedInstances,
      cpuParts: { grid: this._gridMs, collect: this._collectMs, bake: this._bakeMs },
      hlod: {
        slots: this._hlodSlotCount,
        groups: this._hlodGroupCount,
        cellMax: this._hlodCellMax,
      },
    };
  }

  /** LOD 階數。1 代表沒有 LOD 鏈。 */
  get levelCount(): number {
    return this.lodErrors.length;
  }

  /**
   * 自動產生 LOD 的成本拆解。沒有自動產生時是 null。
   *
   * `generationMs` 與 `mainThreadMs` 一定要分開看：「在 worker 裡跑」這句話
   * 若沒有主執行緒那一項撐著，就只是一個宣稱。
   */
  get lodStats(): LodStats | null {
    return this._lodStats;
  }

  /**
   * 上一幀實際送去畫的 instance id。
   *
   * ## 為什麼這要是公開的
   *
   * 剔除唯一真正重要的正確性條件是「**沒有任何該看得見的東西被剔掉**」，
   * 而它在所有時間指標上都是隱形的 —— 症狀只是畫面偶爾破洞。要驗證它
   * 就必須能拿到「這一幀畫了誰」，拿去跟逐一測試的結果比對。
   *
   * 每次呼叫建立一個 `subarray` 檢視，不要放進每幀路徑。
   */
  get drawnInstances(): Uint32Array {
    const indirect = this.internals._indirectTexture.image.data as Uint32Array;
    return indirect.subarray(0, this._visibleInstances);
  }

  override setMatrixAt(instanceId: number, matrix: Matrix4): this {
    super.setMatrixAt(instanceId, matrix);
    this.invalidateInstances();
    return this;
  }

  /**
   * 把容量長到至少 `needed`。已寫入的矩陣會保留。
   *
   * 給串流用的：世界比記憶體大的時候，「同時常駐幾個 instance」是相機
   * 走到哪裡決定的，不是使用者一開始猜得出來的數字。
   *
   * 成長是**加倍**而不是剛好夠 —— 每次多一格就重配一次的話，走一段路
   * 就會重配幾百次，而每一次都是整張矩陣貼圖。
   */
  ensureCapacity(needed: number): void {
    if (needed <= this._capacity) return;

    const target = Math.max(needed, this._capacity * 2, 16);
    this.setInstanceCount(target);
    for (let i = this._capacity; i < target; i++) this.addInstance(0);
    this._capacity = target;

    // `setInstanceCount` 重新配置了矩陣貼圖，所以共用的那塊記憶體換人了。
    // 忘了重新綁定的話，之後所有的寫入都會落在一塊沒人在看的舊陣列上 ——
    // 畫面停在重配之前的樣子，而且不會報錯。
    this.matricesArray = this.internals._matricesTexture.image.data as Float32Array;
    this._instanceMatrix = new InstancedBufferAttribute(
      this.matricesArray.subarray(0, target * 16),
      16,
    );
    this._instanceMatrix.setUsage(DynamicDrawUsage);
    this.lastMatrixVersion = this._instanceMatrix.version;
    this.invalidateInstances();
  }

  /**
   * 把 `[from, from + length)` 的矩陣搬到 `to`。範圍不可重疊。
   *
   * 串流卸載一個 cell 之後會留下一個洞。用遮罩跳過那些槽位要在每個
   * instance 的熱迴圈裡多一次查表；把**最後一塊**搬進洞裡則是一次
   * memcpy，而且讓存活的 instance 永遠緊密排在 `[0, count)`。
   *
   * 這麼做會讓 instance 的索引改變 —— 對串流的內容沒關係（使用者只回答
   * 「這格有什麼」，不持有索引），但**手動 `setMatrixAt` 的內容不能用
   * 這條路**。
   */
  /**
   * 從 `start` 開始寫入一批連續的矩陣（column-major，每 16 個一組）。
   *
   * 給串流用的：一次寫幾百個時，逐個 `setMatrixAt` 會呼叫幾百次函式、
   * 標記幾百次貼圖更新。這裡是一次 `set` 加一次標記。
   */
  writeMatrices(start: number, elements: ArrayLike<number>): void {
    this.matricesArray.set(elements, start * 16);
    this.internals._matricesTexture.needsUpdate = true;
    this.lastMatrixVersion = this._instanceMatrix.version;
    this.invalidateInstances();
  }

  moveInstances(from: number, to: number, length: number): void {
    if (length <= 0 || from === to) return;
    this.matricesArray.copyWithin(to * 16, from * 16, (from + length) * 16);
    this.internals._matricesTexture.needsUpdate = true;
    this.lastMatrixVersion = this._instanceMatrix.version;
    this.invalidateInstances();
  }

  override onBeforeRender(
    renderer: WebGLRenderer,
    _scene: Scene,
    camera: Camera,
    geometry: BufferGeometry,
    material: Material,
  ): void {
    // 這一段是**我們**花的時間，不是 renderer 花的。
    //
    // 幀的 CPU 總時間裡混著兩件完全不同的事：這裡的剔除與選階，以及
    // renderer 為每個可見 instance 送出一次繪製。兩者的優化方向相反
    // （前者要更少的走訪，後者要更少的繪製呼叫），把它們加在一起看
    // 會導致修錯地方 —— 那個錯誤犯過一次了（`admit` 的 0.984 ms 有 98%
    // 是呼叫端的）。
    const started = performance.now();

    // 使用者也可能直接寫 instanceMatrix.array —— 那條路徑不經過 setMatrixAt，
    // 所以要靠 needsUpdate 才知道格子過期了。
    if (this.instanceMatrix.version !== this.lastMatrixVersion) {
      this.lastMatrixVersion = this.instanceMatrix.version;
      this.internals._matricesTexture.needsUpdate = true;
      this.invalidateInstances();
    }
    // count 是普通欄位（`THREE.Mesh` 本來就有），沒有 setter 可掛，
    // 所以在這裡比對。夾在合法範圍內：越界的 count 會讓走訪讀到別人的矩陣。
    const clamped = Math.max(0, Math.min(this.count | 0, this._capacity));
    if (clamped !== this.count) this.count = clamped;
    if (clamped !== this.lastCount) {
      this.lastCount = clamped;
      this.invalidateInstances();
    }

    _inverse.copy(this.matrixWorld).invert();
    _cameraLocal.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_inverse);
    frustumFromCamera(this.frustum, camera, this.matrixWorld, _cameraLocal);

    const gridStarted = performance.now();
    const ranges = this.prepareGrid();
    this._gridMs = performance.now() - gridStarted;
    const ppu = this.projectionScale(renderer, camera);

    const index = geometry.getIndex();
    const bytesPerElement = index === null ? 1 : index.array.BYTES_PER_ELEMENT;
    // wireframe 會讓 renderer 隱式建立線段索引，數量是三角形索引的兩倍。
    const multiplier = (material as { wireframe?: boolean }).wireframe === true ? 2 : 1;

    this.frameIndex++;
    const collectStarted = performance.now();
    this.collect(ranges, ppu, bytesPerElement, multiplier);
    this._collectMs = performance.now() - collectStarted;
    // 烘在**收集之後**：這一幀想要哪幾格，收集的時候才知道。
    const bakeStarted = performance.now();
    this.serviceHlod();
    this._bakeMs = performance.now() - bakeStarted;
    this._cpuMs = performance.now() - started;
  }

  /** 需要時重建空間格；連續多幀都髒就永久退回逐 instance 走訪。 */
  private prepareGrid(): { bounds: Int32Array; count: number } | null {
    if (this.dynamic) return null;

    if (this.grid.needsRebuild) {
      this.consecutiveInvalidations++;
      if (this.consecutiveInvalidations > DYNAMIC_THRESHOLD) {
        this.dynamic = true;
        console.warn(
          `WW.InstancedMesh: 矩陣連續 ${DYNAMIC_THRESHOLD} 幀都在變，已停用空間分割剔除。\n` +
            '空間格的重建是 O(n log n)，每幀重建會比不做還慢。逐 instance 的視錐剔除與 LOD 仍然照常運作。\n' +
            '如果只有少數 instance 在動，把它們拆成另一個 WW.InstancedMesh 可以讓其餘的保留空間分割。',
        );
        return null;
      }
      this.grid.rebuild(this.matricesArray, this.count, this.gridRadius, this.instancesPerCell);
      this.buildHlod();
    } else {
      this.consecutiveInvalidations = 0;
    }

    return this.grid.update(this.frustum, _cameraLocal.x, _cameraLocal.y, _cameraLocal.z);
  }

  /**
   * 把每一格的最粗階烘成一份合併幾何。
   *
   * ## 為什麼
   *
   * 遠處的 instance 幾乎不花三角形，卻各自付一次完整的繪製成本。實測
   * 一次繪製要 167 ns，而遠景一個 instance 只有 4 個三角形（0.008 ns）——
   * **送出去的錢比畫的東西貴 19 倍**。一整格併成一次繪製就把那筆錢省掉。
   *
   * ## 代價
   *
   * 記憶體：合併幾何等於把最粗階複製 N 份。所以有預算，超過就不啟用 ——
   * 而且**說出來**。靜靜不啟用的話使用者會以為自己拿到了它。
   *
   * ## 為什麼在這裡做而不是建構時
   *
   * 要等兩件事都到齊：LOD 鏈（自動產生的話要等 worker）與空間格。
   * 兩者都到齊的時刻就是空間格剛重建完，也就是這裡。
   */
  private buildHlod(): void {
    // 上一輪的合併幾何要先拆掉。不拆的話每次矩陣一改就多一整份，而症狀是
    // 記憶體一路長，畫面完全正常。
    for (const slot of this.hlodSlots ?? []) {
      this.deleteInstance(slot.instanceId);
      this.deleteGeometry(slot.geometryId);
    }
    this.hlodGroups = null;
    this.hlodSlots = null;
    this.hlodWanted = [];

    const coarsest = this.coarsestGeometry;
    if (!this.hlodEnabled || this.lodErrors.length < 2 || coarsest === null) return;

    const ranges = this.grid.cellRanges;
    const cells = ranges.length / 2;
    if (cells === 0) return;

    // ## 記憶體需求是「同時看得見多少格」，不是「世界有多少格」
    //
    // 走過兩個錯的版本：
    //
    // 1. 先算整份要多少，超過就一格都不合併 → 一道懸崖。實測 250,000 個
    //    instance 幀 p50 是 9.30 ms，一百萬個變成 **100.85 ms**，而合併格數
    //    是 0 —— 不是硬體撐不住，是功能被自己的預算關掉了。
    // 2. 一格一格花到預算用完 → 平順了，但一百萬個仍然只涵蓋 3,378 / 15,625 格。
    //
    // 真正的問題是「一次烘全部」：任何一刻需要合併幾何的只有**看得見的
    // 遠景**，而那個數量由視野決定。所以改成一池固定大小的槽位反覆換內容，
    // 池的大小由預算決定，內容按需要換。
    const perInstance = mergedSize(coarsest, 1);
    // 每一格的包圍球要在**烘之前**就知道 —— 決定「這一格夠遠了嗎」不能等到
    // 烘完，否則就變成「先烘再看要不要用」。用已經快取好的逐 instance
    // 包圍球算，比烘便宜好幾個數量級。
    this.ensureSpheres();
    const spheres = this.spheres;
    const invBaseRadius = this.boundsRadius > 0 ? 1 / this.boundsRadius : 1;

    // 槽位一律一樣大 —— 大小不一的話回收之後就換不進去，池子會碎掉。
    // 預設是「最大那一格」，一格一個槽位。
    let maxCellInstances = 0;
    for (let cell = 0; cell < cells; cell++) {
      const size = ranges[cell * 2 + 1]! - ranges[cell * 2]!;
      if (size >= HLOD_MIN_INSTANCES && size > maxCellInstances) maxCellInstances = size;
    }
    if (maxCellInstances === 0) return;
    const chunk = Math.max(this.hlodSlotInstances ?? maxCellInstances, HLOD_MIN_INSTANCES);

    const groups: HlodGroup[] = [];
    for (let cell = 0; cell < cells; cell++) {
      const cellFrom = ranges[cell * 2]!;
      const cellTo = ranges[cell * 2 + 1]!;
      for (let from = cellFrom; from < cellTo; from += chunk) {
      const to = Math.min(from + chunk, cellTo);
      // 一份只有一兩個 instance 的話，合併省不到什麼，卻照樣佔一個槽位。
      if (to - from < HLOD_MIN_INSTANCES) continue;

      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let slot = from; slot < to; slot++) {
        const s = slot * 4;
        cx += spheres[s]!;
        cy += spheres[s + 1]!;
        cz += spheres[s + 2]!;
      }
      const n = to - from;
      cx /= n;
      cy /= n;
      cz /= n;

      // 半徑取「中心到每個 instance 的球心 + 那個 instance 的半徑」的最大值
      // —— 保守地涵蓋整格。低估的方向是把不夠遠的格子當成夠遠，那會靜靜
      // 降低畫質。
      let radius = 0;
      let maxScale = 0;
      for (let slot = from; slot < to; slot++) {
        const s = slot * 4;
        const dx = spheres[s]! - cx;
        const dy = spheres[s + 1]! - cy;
        const dz = spheres[s + 2]! - cz;
        const r = spheres[s + 3]!;
        const reach = Math.sqrt(dx * dx + dy * dy + dz * dz) + r;
        if (reach > radius) radius = reach;
        if (r > maxScale) maxScale = r;
      }

      groups.push({
        from,
        to,
        slot: -1,
        centerX: cx,
        centerY: cy,
        centerZ: cz,
        radius,
        maxScale: maxScale * invBaseRadius,
      });
      }
    }
    if (groups.length === 0) return;

    // 槽位一律保留「最大那一格」的空間，所以任何一格都放得進任何一個槽位
    // —— 大小不一的話回收之後就換不進去，池子會碎掉。
    const slotVertices = chunk * perInstance.vertices;
    const slotIndices = chunk * perInstance.indices;
    const slotBytes = slotVertices * 12 + slotIndices * 4;
    const slotCount = Math.min(groups.length, Math.floor(this.hlodBudgetBytes / slotBytes));
    // 交出去給開發者判斷：槽位滿載代表「調高 hlodBudgetMB 會有用」，而
    // 那是政策不是引擎該自己決定的。
    this._hlodSlotCount = slotCount;
    this._hlodGroupCount = groups.length;
    this._hlodCellMax = maxCellInstances;

    if (slotCount === 0) {
      console.info(
        'WW.InstancedMesh: 沒有啟用遠景合併 —— 最粗階有 ' +
          `${Math.round((coarsest.getIndex()?.count ?? coarsest.getAttribute('position')!.count) / 3)} 個三角形，` +
          `一格要 ${(slotBytes / 1048576).toFixed(1)} MB，放不進 ` +
          `${(this.hlodBudgetBytes / 1048576).toFixed(0)} MB 的預算。\n` +
          '剔除與 LOD 照常運作。要啟用的話把 hlodBudgetMB 調高，或讓 cook 產生更粗的階。',
      );
      return;
    }
    if (slotCount < groups.length) {
      console.info(
        `WW.InstancedMesh: 遠景合併有 ${slotCount} 個槽位、${groups.length} 格內容 —— ` +
          '槽位會依需要換（最久沒畫到的先回收）。同時看得見的遠景超過槽位數時，' +
          '多出來的那幾格照原本逐 instance 送。調高 hlodBudgetMB 可以放更多。',
      );
    }

    // 一次把整池配好。之後只用 `setGeometryAt` 換內容 —— `addGeometry` 會
    // 重用 id 但**不會重用緩衝區空間**，所以刪掉再加是會漏的。
    if (slotVertices * slotCount > this.unusedVertexCount) {
      this.setGeometrySize(
        this.internals._maxVertexCount + slotVertices * slotCount,
        this.internals._maxIndexCount + slotIndices * slotCount,
      );
    }
    if (this.internals._maxInstanceCount < this._capacity + slotCount) {
      this.setInstanceCount(this._capacity + slotCount);
      // `setInstanceCount` 換掉了矩陣貼圖。下面要讀它來烘幾何，讀到舊的
      // 那一份會拿到全零的矩陣 —— 所有東西疊在原點，而且不會報錯。
      this.rebindMatrices(this._capacity);
    }

    // 佔位幾何的屬性佈局必須與其他階一致，否則 addGeometry 會拒絕。
    const placeholder = placeholderLike(coarsest);
    const slots: HlodSlot[] = [];
    for (let i = 0; i < slotCount; i++) {
      // 用一個空幾何佔位，保留最大那一格的空間。
      const geometryId = this.addGeometry(placeholder, slotVertices, slotIndices);
      const info = this.internals._geometryInfo[geometryId]!;
      slots.push({
        geometryId,
        instanceId: this.addInstance(geometryId),
        start: info.start,
        count: 0,
        group: -1,
        lastUsed: -1,
      });
    }

    placeholder.dispose();

    this.hlodGroups = groups;
    this.hlodSlots = slots;
    this.hlodWanted = [];
  }

  /**
   * 把這一幀想要合併、但還沒烘好的格子烘出來。
   *
   * ## 為什麼有每幀上限
   *
   * 烘一格要走過它每一個 instance 的每一個頂點。一次把幾百格烘完會是一次
   * 明顯的卡頓，而那正好發生在**相機剛轉過去**的時候 —— 使用者最有感的
   * 時機。分攤到幾幀之內，代價是那幾格晚幾幀才變成一次繪製（在那之前照
   * 原本逐 instance 送，畫面完全正確）。
   */
  private serviceHlod(): void {
    const groups = this.hlodGroups;
    const slots = this.hlodSlots;
    const coarsest = this.coarsestGeometry;
    if (groups === null || slots === null || coarsest === null) return;
    if (this.hlodWanted.length === 0) return;

    const order = this.grid.order;
    const deadline = performance.now() + HLOD_BAKE_BUDGET_MS;
    for (const index of this.hlodWanted) {
      if (performance.now() >= deadline) break;
      const group = groups[index];
      if (group === undefined || group.slot >= 0) continue;

      // 先找空的，沒有空的就回收最久沒畫到的那一個。
      let pick = -1;
      let oldest = Infinity;
      for (const [i, slot] of slots.entries()) {
        if (slot.group < 0) {
          pick = i;
          break;
        }
        if (slot.lastUsed < oldest) {
          oldest = slot.lastUsed;
          pick = i;
        }
      }
      const slot = slots[pick];
      if (slot === undefined) break;
      // 這一幀已經畫到的槽位不能搶 —— 搶了就會把正在用的內容換掉。
      if (slot.group >= 0 && slot.lastUsed === this.frameIndex) break;

      const merged = mergeInstances(coarsest, this.matricesArray, order, group.from, group.to);
      if (merged === null) continue;

      if (slot.group >= 0) groups[slot.group]!.slot = -1;
      this.setGeometryAt(slot.geometryId, merged.geometry);
      slot.count = this.internals._geometryInfo[slot.geometryId]!.count;
      slot.group = index;
      slot.lastUsed = this.frameIndex;
      merged.geometry.dispose();

      _hlodMatrix.makeTranslation(merged.center[0], merged.center[1], merged.center[2]);
      // **走 super，不走自己覆寫的那個。** 我們的 `setMatrixAt` 會把空間格
      // 標成過期 —— 標過期就變成「每幀都在改矩陣」，八幀之後整個空間分割
      // 會被當成動態內容關掉。那個 bug 的樣子是幀時間變差而畫面完全正常。
      super.setMatrixAt(slot.instanceId, _hlodMatrix);

      group.slot = pick;
      group.centerX = merged.center[0];
      group.centerY = merged.center[1];
      group.centerZ = merged.center[2];
      group.radius = merged.radius;
      group.maxScale = merged.maxScale;
    }
    this.hlodWanted.length = 0;
  }

  /** `setInstanceCount` 之後重新指向新的矩陣貼圖。見 `ensureCapacity` 的說明。 */
  private rebindMatrices(count: number): void {
    this.matricesArray = this.internals._matricesTexture.image.data as Float32Array;
    this._instanceMatrix = new InstancedBufferAttribute(
      this.matricesArray.subarray(0, count * 16),
      16,
    );
    this._instanceMatrix.setUsage(DynamicDrawUsage);
    this.lastMatrixVersion = this._instanceMatrix.version;
  }

  /**
   * 走訪、剔除、選階，把結果寫進 `BatchedMesh` 的繪製表。
   *
   * 這是整個類別唯一的熱迴圈。矩陣直接從 `Float32Array` 讀 —— 不建
   * `Matrix4`、不建 `Sphere`、不呼叫 `getMatrixAt`。Three.js 自己那份
   * 每個 instance 要配置一次 `Sphere` 的轉換結果，那是它最貴的部分。
   */
  /**
   * 把每個 instance 的世界空間包圍球算好：`[cx, cy, cz, radius]`。
   *
   * ## 為什麼值得快取
   *
   * 熱迴圈原本每個 instance 要讀 12 個矩陣元素，做九次乘加算最大縮放、
   * 再做九次把球心轉到世界空間。那些值**只在矩陣改變時才會變**，卻每幀
   * 重算一次。
   *
   * 天花板場景說得很清楚：把同一批矩陣純粹讀過一遍是每個 4 ns，而我們的
   * 迴圈是 123 ns —— 差 30 倍，而差距幾乎全在這些重算上。
   *
   * 代價是每個 instance 多 16 個位元組，以及矩陣改變時多走一趟。
   */
  /**
   * 矩陣改了：空間格與包圍球快取都要重算。
   *
   * 兩者**必須一起**失效。 不會動 ，
   * 所以只靠版本號判斷快取的話，用  的人會永遠拿到舊的包圍球
   * —— 物件搬走了，剔除與選階卻還在看原本的位置。
   */
  /**
   * 矩陣改了：空間格與包圍球快取都要重算。
   *
   * 兩者**必須一起**失效。`setMatrixAt` 不會動 `instanceMatrix.version`，
   * 所以只靠版本號判斷快取的話，用 `setMatrixAt` 的人會永遠拿到舊的包圍球
   * —— 物件搬走了，剔除與選階卻還在看原本的位置。
   */
  private invalidateInstances(): void {
    this.grid.invalidate();
    this.spheresDirty = true;
  }

  private ensureSpheres(): void {
    const needed = this.count * 4;
    if (this.spheres.length < needed) this.spheres = new Float32Array(needed);
    // **依走訪順序存，不是依 instance 編號。**
    //
    // 走訪是照空間格的順序走的（`grid.order`），所以用編號當索引時每一次
    // 讀都是陣列裡的隨機位置。一百萬個 instance 的快取是 16 MB，遠超過 L2
    // —— 實測每個 instance 從 59 ns（六萬個，快取 960 KB）惡化到 **146 ns**，
    // 同一段程式碼慢 2.5 倍，差別純粹是快取命中。
    //
    // 排成走訪順序之後就是循序讀。代價是格子重建時要跟著重排，而那本來
    // 就是同一個時機。
    const byOrder = !this.dynamic && this.grid.order.length >= this.count;
    if (!this.spheresDirty && this.spheresCount === this.count && this.spheresByOrder === byOrder) {
      return;
    }

    const m = this.matricesArray;
    const spheres = this.spheres;
    const order = this.grid.order;
    const bcx = this.boundsCenter.x;
    const bcy = this.boundsCenter.y;
    const bcz = this.boundsCenter.z;
    const baseRadius = this.boundsRadius;

    for (let slot = 0; slot < this.count; slot++) {
      const id = byOrder ? order[slot]! : slot;
      const b = id * 16;
      const m0 = m[b]!;
      const m1 = m[b + 1]!;
      const m2 = m[b + 2]!;
      const m4 = m[b + 4]!;
      const m5 = m[b + 5]!;
      const m6 = m[b + 6]!;
      const m8 = m[b + 8]!;
      const m9 = m[b + 9]!;
      const m10 = m[b + 10]!;

      // 三個軸的縮放取最大 —— 包圍球對非等比縮放只能取保守值，
      // 而保守的方向是多畫，不是消失。
      //
      // 先比平方再開一次根號。`Math.hypot` 為了避免中間值溢位做了額外的
      // 縮放與檢查，那在這裡是白付的代價：矩陣分量的量級早就受限於世界
      // 大小，溢位不可能發生。實測三次 hypot 換成一次 sqrt：每個 instance
      // 176 → 126 ns。
      const sx = m0 * m0 + m1 * m1 + m2 * m2;
      const sy = m4 * m4 + m5 * m5 + m6 * m6;
      const sz = m8 * m8 + m9 * m9 + m10 * m10;
      const scale = Math.sqrt(sx > sy ? (sx > sz ? sx : sz) : sy > sz ? sy : sz);

      const s = slot * 4;
      spheres[s] = m0 * bcx + m4 * bcy + m8 * bcz + m[b + 12]!;
      spheres[s + 1] = m1 * bcx + m5 * bcy + m9 * bcz + m[b + 13]!;
      spheres[s + 2] = m2 * bcx + m6 * bcy + m10 * bcz + m[b + 14]!;
      spheres[s + 3] = baseRadius * scale;
    }

    this.spheresDirty = false;
    this.spheresCount = this.count;
    this.spheresByOrder = byOrder;
  }

  private collect(
    ranges: { bounds: Int32Array; count: number } | null,
    ppu: number,
    bytesPerElement: number,
    multiplier: number,
  ): void {
    this.ensureSpheres();
    const spheres = this.spheres;
    const invBaseRadius = this.boundsRadius > 0 ? 1 / this.boundsRadius : 1;
    const order = this.grid.order;
    const starts = this.internals._multiDrawStarts;
    const counts = this.internals._multiDrawCounts;
    const indirect = this.internals._indirectTexture.image.data as Uint32Array;
    const errors = this.lodErrors;
    const lodRanges = this.lodRanges;
    const levelCounts = this._levelCounts;
    const hasLod = errors.length > 1;
    const errorPixels = this.errorPixels;

    const camX = _cameraLocal.x;
    const camY = _cameraLocal.y;
    const camZ = _cameraLocal.z;
    const planes = this.frustum.planes;

    levelCounts.fill(0);
    let drawCount = 0;
    let tested = 0;
    let merged = 0;
    let mergedInstances = 0;

    // 合併過的格子，依 `order` 位置排序（建的時候就是這個順序）。
    const groups = this.hlodGroups;
    const slots = this.hlodSlots;
    const wanted = this.hlodWanted;
    const frame = this.frameIndex;
    const coarsest = errors.length - 1;
    let nextGroup = 0;

    // 有範圍表就只走可見 cell，沒有就走全部 —— 迴圈只有一種形狀，
    // 差別只在外層取哪些段。兩份 body 是這裡最容易寫歪的地方。
    const spanCount = ranges === null ? 1 : ranges.count;
    const bounds = ranges?.bounds;

    for (let span = 0; span < spanCount; span++) {
      const from = bounds === undefined ? 0 : bounds[span * 2]!;
      const to = bounds === undefined ? this.count : bounds[span * 2 + 1]!;

      for (let slot = from; slot < to; slot++) {
        // ── 遠景合併 ──
        //
        // 這一格整個都會挑最粗階的話，送一次合併好的幾何取代整格。
        // 遠景一個 instance 只有幾個三角形，成本幾乎全在「送出去」——
        // 一次繪製 167 ns，而那幾個三角形是 0.008 ns。
        if (groups !== null && slots !== null && bounds !== undefined) {
          while (nextGroup < groups.length && groups[nextGroup]!.from < slot) nextGroup++;
          const group = groups[nextGroup];
          if (group !== undefined && group.from === slot && group.to <= to) {
            const gx = group.centerX - camX;
            const gy = group.centerY - camY;
            const gz = group.centerZ - camZ;
            // **用最近的那一點判斷，不是中心。** 用中心的話近側的 instance
            // 會被降階，而那是靜靜違反品質契約 —— 畫面只是「近處有點粗」。
            const nearest = Math.max(Math.sqrt(gx * gx + gy * gy + gz * gz) - group.radius, 1e-6);
            // **要帶上縮放。** 逐一判斷用的是 scale/distance，合併若只用
            // 1/distance 就等於把物件當成小了 scale 倍 —— 太早合併，而症狀
            // 是遠處提早變粗，畫面完全正常。
            if (selectLevel(errors, (group.maxScale / nearest) * ppu, errorPixels) === coarsest) {
              const baked = group.slot >= 0 ? slots[group.slot] : undefined;
              if (baked !== undefined && baked.group === nextGroup) {
                baked.lastUsed = frame;
                starts[drawCount] = baked.start * bytesPerElement * multiplier;
                counts[drawCount] = baked.count * multiplier;
                indirect[drawCount] = baked.instanceId;
                drawCount++;
                merged++;
                // **不計進 levelCounts。** 合併是整格送出去的，裡面包含視錐外
                // 的 instance；算進去會讓「最粗階有幾個」膨脹，於是分不出
                // 「真的被降級了」與「只是多算了看不見的」。
                mergedInstances += group.to - group.from;
                tested += group.to - group.from;
                slot = group.to - 1; // for 迴圈的 ++ 會把它帶到 group.to
                continue;
              }
              // 還沒烘好。登記起來下一幀處理，**這一幀照原本逐 instance 送**
              // —— 停下來等它烘完會變成一次卡頓，而畫面本來就是正確的。
              wanted.push(nextGroup);
            }
          }
        }

        const id = bounds === undefined ? slot : order[slot]!;
        if (id >= this.count) continue;
        tested++;

        // 世界空間的包圍球是**預先算好的**，而且**照走訪順序排**
        // （見 `ensureSpheres`）—— 所以這裡是循序讀，不是隨機跳。
        //
        // 這裡原本每個 instance 要讀 12 個矩陣元素、做九次乘加算縮放、
        // 再做九次算球心 —— 而那些值只在矩陣改變時才會變，卻每幀重算。
        // 現在讀 4 個 float，其餘全部在矩陣改變的那一次就算完。
        const s = slot * 4;
        const radius = spheres[s + 3]!;
        const cx = spheres[s]! - camX;
        const cy = spheres[s + 1]! - camY;
        const cz = spheres[s + 2]! - camZ;

        let inside = true;
        for (let p = 0; p < 24; p += 4) {
          if (planes[p]! * cx + planes[p + 1]! * cy + planes[p + 2]! * cz + planes[p + 3]! < -radius) {
            inside = false;
            break;
          }
        }
        if (!inside) continue;

        let level = 0;
        if (hasLod) {
          const distance = Math.sqrt(cx * cx + cy * cy + cz * cz);
          // 半徑已經含了縮放，所以 scale = radius / baseRadius。除法換成
          // 預先算好的倒數乘法。
          level = selectLevel(
            errors,
            ((radius * invBaseRadius) / Math.max(distance, 1e-6)) * ppu,
            errorPixels,
          );
        }
        levelCounts[level]!++;

        starts[drawCount] = lodRanges[level * 2]! * bytesPerElement * multiplier;
        counts[drawCount] = lodRanges[level * 2 + 1]! * multiplier;
        indirect[drawCount] = id;
        drawCount++;
      }
    }

    this._visibleInstances = drawCount;
    this._testedInstances = tested;
    this._mergedDraws = merged;
    this._mergedInstances = mergedInstances;
    this.internals._indirectTexture.needsUpdate = true;
    this.internals._multiDrawCount = drawCount;
    this.internals._visibilityChanged = false;
  }

  /**
   * 世界 1 單位在 1 單位距離處佔多少像素。
   *
   * ## 為什麼要問「現在畫到哪裡」而不是直接問畫布多大
   *
   * 螢幕誤差的分母是**這一次繪製的目標高度**，不是畫布高度。三種情況會
   * 讓兩者不同，而三種都很常見：
   *
   * - **後處理**：`EffectComposer` 把場景畫進 render target。半解析度的
   *   composer 用畫布高度算，會讓每個物件都選到太細的階 —— 白付三角形，
   *   而且**看不出來**（畫面正確，只是慢）。
   * - **陰影**：`onBeforeShadow` 會轉呼叫這裡，目標是 shadow map。
   *   2048² 的 shadow map 與 1080p 的畫布差了快兩倍。
   * - **離屏預覽、反射探針**：同理。
   *
   * `getRenderTarget()` 回傳 null 就代表畫到畫布上。
   */
  private projectionScale(renderer: WebGLRenderer, camera: Camera): number {
    const target = renderer.getRenderTarget();
    const height =
      target !== null ? target.height : renderer.getDrawingBufferSize(_size).height;

    const perspective = camera as Camera & { isPerspectiveCamera?: boolean; fov?: number };
    if (perspective.isPerspectiveCamera === true) {
      return pixelsPerUnit(height, (perspective.fov! * Math.PI) / 180);
    }
    const ortho = camera as Camera & {
      isOrthographicCamera?: boolean;
      top?: number;
      bottom?: number;
      zoom?: number;
    };
    if (ortho.isOrthographicCamera === true) {
      // 正交投影沒有透視收縮，像素/單位是常數。回傳的值之後仍會被除以
      // 距離，所以先乘回去讓兩條路徑共用同一個熱迴圈。
      return (height * ortho.zoom!) / Math.max(ortho.top! - ortho.bottom!, 1e-6);
    }
    return height;
  }

  private warnSingleLevel(): void {
    if (this.warnedSingleLevel) return;
    this.warnedSingleLevel = true;
    console.info(
      'WW.InstancedMesh: 只有一階幾何，所以不會做 LOD —— 遠處的 instance 會一直用最細的幾何。\n' +
        '空間分割剔除照常運作。要啟用 LOD，傳入 { lods: [細…粗], errors: [0, …] }。',
    );
  }
}

/**
 * 抽出 worker 需要的資料，並且**複製**每一個緩衝區。
 *
 * 複製是必要的：`postMessage` 的轉移會把來源緩衝區抽走，而那是**使用者的**
 * `BufferGeometry` —— 被抽走之後畫面直接空掉。複製一份幾百 KB 的幾何遠比
 * 簡化本身便宜。
 *
 * @returns 不能處理時回傳原因字串。
 */
function toGeometryData(geometry: BufferGeometry): GeometryData | string {
  if (geometry.morphAttributes !== undefined && Object.keys(geometry.morphAttributes).length > 0) {
    return '有 morph target';
  }

  const attributes: Record<string, { array: Float32Array; itemSize: number }> = {};
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if ((attribute as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) {
      return `attribute "${name}" 是交錯的`;
    }
    if (name === 'skinIndex' || name === 'skinWeight') return '有骨骼權重';
    const array = attribute.array;
    if (!(array instanceof Float32Array)) {
      // 正規化整數 attribute 直接轉成 float 會改變語意，而那個錯誤是
      // 顏色或法線靜靜地變掉 —— 寧可不做。
      return `attribute "${name}" 不是 Float32Array`;
    }
    attributes[name] = { array: new Float32Array(array), itemSize: attribute.itemSize };
  }

  if (attributes['position'] === undefined) return '沒有 position attribute';

  const index = geometry.getIndex();
  return {
    attributes,
    indices: index === null ? null : Uint32Array.from(index.array),
  };
}

function toBufferGeometry(level: GeneratedLevel): BufferGeometry {
  const geometry = new ThreeBufferGeometry();
  for (const [name, attribute] of Object.entries(level.attributes)) {
    geometry.setAttribute(name, new BufferAttribute(attribute.array, attribute.itemSize));
  }
  geometry.setIndex(new BufferAttribute(level.indices, 1));
  return geometry;
}

/**
 * `BatchedMesh` 要求同一批的幾何全部有索引或全部沒有。
 *
 * 混用的話 `addGeometry` 會丟例外，而使用者拿到的是一句看不懂的
 * 「Batched geometry attributes do not match」—— 所以這裡直接補齊。
 * 補索引只在建構時做一次，成本不進每幀路徑。
 *
 * @param forceIndex 自動 LOD 會產生**有索引**的階（簡化的前提就是索引），
 *   所以待補鏈的批次一定要是索引的，即使第 0 階原本不是。
 */
function unifyIndexing(geometries: BufferGeometry[], forceIndex = false): BufferGeometry[] {
  const anyIndexed = forceIndex || geometries.some((g) => g.getIndex() !== null);
  if (!anyIndexed) return geometries;

  return geometries.map((geometry) => {
    if (geometry.getIndex() !== null) return geometry;
    const vertices = geometry.getAttribute('position')!.count;
    const array =
      vertices > 65535 ? new Uint32Array(vertices) : (new Uint16Array(vertices) as Uint16Array);
    for (let i = 0; i < vertices; i++) array[i] = i;
    const clone = geometry.clone();
    clone.setIndex(new BufferAttribute(array, 1));
    return clone;
  });
}
