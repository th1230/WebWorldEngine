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
import { InstanceBlocks } from './instance-blocks.ts';
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
import { installMaterialDetail } from './material-detail.ts';

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
   * 這批 instance 的矩陣會不會在執行時一直變。預設 **false（靜態）**。
   *
   * 這是**宣告**，不是引擎去猜的東西 —— 大量放置幾乎都是靜態的（樹、石頭、
   * 建築），而靜態才享有空間分割剔除：格子建一次用一輩子。
   *
   * | 你寫的 | 引擎做的 |
   * | --- | --- |
   * | `dynamic: true` | 不建格子，逐 instance 剔除與選階照常。矩陣愛怎麼動就怎麼動，**不猜也不警告** |
   * | `dynamic: false` | 永遠用格子。矩陣真的一直在變時警告你宣告錯了，但**不偷偷換策略** |
   * | 省略 | 當靜態。矩陣一直在變時警告，並且在量到「重建比省下的走訪還貴」之後暫停格子（`stats.spatial` 讀得到，停下來就恢復） |
   *
   * 省略時的那個暫停不是一個我訂的幀數門檻，是拿這台機器上剛量到的兩個
   * 數字比出來的。但**宣告過的就不比** —— 引擎不推論它本來可以被告知的事。
   */
  dynamic?: boolean;
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
   * 遠景合併的記憶體預算，MB。**省略的話要多少給多少**（上限 512 MB）。
   *
   * 需要的量在執行時就知道：可合併的格數 × 一格的大小。所以預設不是一個
   * 我訂的數字。給定值只在「這個網站的記憶體要留給別的東西」時才有意義，
   * 而那是政策，引擎不知道。
   *
   * 預算不夠時涵蓋的格數會減少（平順降級），並且在 console 說明涵蓋了多少。
   */
  hlodBudgetMB?: number;
  /**
   * 一個合併槽位裝得下幾個 instance。預設是**最大那一格**（一格一個槽位）。
   *
   * 調小會得到更多槽位（同樣預算），代價是大格子被拆成幾次繪製。值不值得
   * 取決於格子大小的分佈 —— 一個離群的大格子會把每個槽位都撐大。
   */
  hlodSlotInstances?: number;
  /**
   * 每幀最多花多少毫秒烘遠景合併。預設 2。
   *
   * 這筆錢花的是**開發者的幀預算**，所以上限是他的（`hlodBudgetMB` 同理）。
   *
   * 預設之所以是一個小的固定值而不是量出來的：兩邊的失敗形態完全不對稱。
   * 給太多會在相機轉過去的那一幀卡一下 —— **看得見**；給太少只是遠景晚
   * 幾幀才併起來，而沒併起來的格子照樣畫得正確 —— **看不見**。所以往小的
   * 那邊錯。2 ms 在任何機器上都低於一個 60 Hz 的幀（16.7 ms）。
   *
   * 而「太小就不會進展」這個風險是另外處理的：**每幀至少烘一格**，不管
   * 預算剩多少。所以慢機器不會永遠停在未合併的狀態。
   */
  hlodBakeMs?: number;
  /**
   * 貼圖被縮到這個程度以下就不再取樣 normal 與 ORM。**預設關。**
   *
   * 值是「一個 fragment 跨過多少 UV」。直覺換算：`1 / 貼圖寬度` 大約是
   * 「一個 fragment 對一個 texel」，所以 1024² 的貼圖給 `0.004` 大約是
   * 縮到四分之一大小的時候。
   *
   * 實測這兩張貼圖在物件很大時佔 GPU 的 27%，只有幾個像素時只佔 8% ——
   * 這筆錢只在貼圖真的看得到時才付得有價值。
   *
   * 但少取樣會讓表面變平，**那是改變畫面**，所以門檻由你訂，引擎不猜。
   * 不設就完全不碰你的材質。
   */
  materialDetailUvPerPixel?: number;
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

/**
 * 一格少於這個數就不合併。
 *
 * 合併的收益是「省下的繪製次數」= `n - 1`，成本是「複製一份幾何」。
 * 所以要有收益就得 `n ≥ 2` —— 這個值是**推導出來的**，不是調出來的，
 * 也因此不給調（見 doctrine 的四問）。
 *
 * 曾經是 4。那是隨手訂的，沒有任何論證撐著。
 */
const HLOD_MIN_INSTANCES = 2;

/**
 * 沒有指定 `hlodBakeMs` 時每幀花在烘合併幾何上的預算，毫秒。
 *
 * **用時間而不是「幾格」當預算**：一格的成本差好幾個數量級（最粗階 4 個
 * 三角形對 3,258 個），而且不同機器差很多。固定格數在小內容上浪費、在大
 * 內容上爆掉 —— 那正是「作者在自己機器上調好」的那種常數。
 *
 * 為什麼預設是一個固定的小數字，見 `InstancedMeshOptions.hlodBakeMs`。
 */
const HLOD_BAKE_BUDGET_MS = 2;

/**
 * 沒有指定 `hlodBudgetMB` 時，遠景合併配置多少，位元組。
 *
 * ## 這是一個政策預設，不是推導出來的值 —— 而它必須是政策
 *
 * 準則說套件裡的數字只有三種合法來源，第三種是「交出去當旋鈕：引擎講清楚
 * 它在權衡什麼，由開發者決定」。這一項就是那種：**引擎不可能知道使用者的
 * 裝置還有多少記憶體可用**，所以「多少算多」只能是開發者的決定。
 *
 * 引擎能做的是（a）預設取一個在網站上安全的量，（b）不夠的時候**說出它想要
 * 多少、拿到多少**，讓那個決定是知情的。
 *
 * ## 為什麼不是「要多少給多少」（上一版的預設）
 *
 * 上一版的理由是「需要多少在執行時就知道，不必猜」，護欄放在 512 MB。那在
 * benchmark 上是對的，在**網站**上是災難 —— `apps/example` 的 JS heap 量到
 * **1,005 MB**（這一輪開始時 165 MB，而 W5 記錄的是 13.8 MB）。
 *
 * 根因是「把我這裡當成全世界」：這台開發機有很多顯示記憶體。512 MB 的
 * 「安全護欄」不是護欄，是一張空白授權書。
 *
 * ## 為什麼不能從內容推導
 *
 * 試過「批次幾何佔多少，最多再要同樣多」。那個比例是錯的：批次幾何是
 * **一份 LOD 鏈**（與 instance 數無關），而合併是**每個 instance 一份最粗階**。
 * 兩個量的階不同，所以任何倍數在某個 instance 數上都會荒謬 —— 實測那個版本
 * 在單元測試的內容上算出 0 個槽位。
 */
const HLOD_DEFAULT_BUDGET_BYTES = 32 * 1048576;

/**
 * 包圍球快取最多追蹤幾段髒區間。
 *
 * 超過就退回「整份重算」—— 那永遠是正確的，只是慢。段數多到這個程度時
 * 逐段重算本來也接近整份，所以不必為了省最後一點而讓資料結構變複雜。
 */
const SPHERE_DIRTY_RANGES = 8;

/** `hlodOps` 的種類。 */
const HLOD_OP_APPEND = 0;
const HLOD_OP_DROP = 1;

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
  /** 目前池子裡一個槽位裝得下幾個 instance。變了就整池作廢。 */
  private hlodChunk = -1;
  /** 最近一次分組算出來的槽位規格。配置延到真的有需求時才做。 */
  private hlodChunkWanted = -1;
  private hlodSlotBytes = 0;
  private hlodSlotVertices = 0;
  private hlodSlotIndices = 0;
  private warnedHlodBudget = false;
  /** 這一幀想合併但還沒烘好的格子。 */
  private hlodWanted: number[] = [];
  /** 這一輪分了幾組。池子要這麼大才不會在穩態下互相回收。 */
  private hlodGroupCount = 0;
  private frameIndex = 0;
  /** 找可回收槽位的旋轉游標。見 `serviceHlod`。 */
  private slotCursor = 0;
  private readonly hlodEnabled: boolean;
  private readonly hlodBudgetBytes: number | null;
  private readonly materialDetailUv: number | undefined;
  private readonly hlodSlotInstances: number | null;
  private readonly hlodBakeMs: number;
  private _mergedDraws = 0;
  private _mergedInstances = 0;
  private _hlodSlotCount = 0;
  private _hlodGroupCount = 0;
  private _hlodCellMax = 0;
  /** 每階的距離平方係數。見 `collect` 的選階。 */
  private levelDistanceSq = new Float64Array(0);
  private _spheresMs = 0;
  private _hlodBuildMs = 0;
  private _mergeMs = 0;
  private _uploadMs = 0;
  /** 每個 instance 的世界空間包圍球：cx, cy, cz, radius。 */
  private spheres = new Float32Array(0);
  /** 整份包圍球快取都要重算。追蹤不下去時也退到這裡。 */
  private spheresAllDirty = true;
  /**
   * 改過矩陣的 instance 編號區間，最多 `SPHERE_DIRTY_RANGES` 段。
   *
   * 用區間而不是逐個編號：串流的每一次寫入都是一段連續的編號
   * （`writeMatrices` 一次寫一格的內容，`moveInstances` 一次搬一塊）。
   */
  private readonly dirtyLo = new Int32Array(SPHERE_DIRTY_RANGES);
  private readonly dirtyHi = new Int32Array(SPHERE_DIRTY_RANGES);
  private dirtyCount = 0;
  private spheresCount = -1;
  /** 快取是照走訪順序排的嗎。格子停用時退回照編號排。 */
  private spheresByOrder = false;
  private readonly errorPixels: number;
  private readonly instancesPerCell: number;
  private readonly grid = new InstanceGrid();
  /**
   * 串流寫進來的區塊。**分割是現成的，不必重算** —— 見 `InstanceBlocks`。
   *
   * 有它的時候就不建空間格：一次 `writeMatrices` 就是一格的內容，邊界在
   * 寫進來的當下就知道。
   */
  private readonly blocks = new InstanceBlocks();
  /** 走訪順序表。區塊路徑用恆等表（位置就是編號），空間格路徑用它的 order。 */
  private identityOrder = new Uint32Array(0);
  private usingBlocks = false;
  /** 區塊變動的待辦：每三個一組（種類, a, b）。見 `updateHlodForBlocks`。 */
  private readonly hlodOps: number[] = [];
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
  /** `options.dynamic`。`undefined` 代表沒宣告 —— 當靜態，但會觀察。 */
  private readonly declaredDynamic: boolean | undefined;
  /** 沒宣告而矩陣一直在變，且量到格子不划算。可恢復。 */
  private gridPaused = false;
  /** 上一幀真的重建了幾毫秒。0 代表沒重建。見 `weighGrid`。 */
  private lastRebuildMs = 0;
  /** 矩陣失效的累計次數，與上一幀看到的值。見 `prepareGrid`。 */
  private moveCount = 0;
  private moveCountSeen = -1;
  /** 每幀重建那段期間累計的重建成本與省下的走訪，毫秒。見 `weighGrid`。 */
  private gridCostMs = 0;
  private gridSavedMs = 0;
  /** 暫停期間累積的「多花的走訪」。累到超過 gridCostMs 就值得再建一次。 */
  private gridPaybackMs = 0;
  /** 格子真的在用時，剔掉了多少比例的 instance。回本的估算要用它。 */
  private gridSkipRatio = 0;
  private warnedMoving = false;
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
    this.declaredDynamic = options.dynamic;
    this.hlodEnabled = options.hlod !== false;
    this.hlodBudgetBytes =
      options.hlodBudgetMB === undefined ? null : options.hlodBudgetMB * 1048576;
    this.hlodSlotInstances = options.hlodSlotInstances ?? null;
    this.hlodBakeMs = options.hlodBakeMs ?? HLOD_BAKE_BUDGET_MS;
    this.materialDetailUv = options.materialDetailUvPerPixel;
    this._capacity = count;
    this.count = count;
    this._levelCounts = new Int32Array(prepared.length);

    // 自己做剔除與排序，所以要把 Three.js 的關掉 —— 否則兩邊都會走訪
    // 全部 instance，而我們的結果會被它覆蓋。
    this.perObjectFrustumCulled = false;
    this.sortObjects = false;

    // **物件層級的視錐剔除必須關掉，而理由是正確性不是效能。**
    //
    // `Frustum.intersectsObject` 對 `BatchedMesh` 讀的是 `this.boundingSphere`，
    // 而那顆球**只算一次然後永遠快取** —— Three 的 `setMatrixAt` 不會讓它失效。
    // 所以只要矩陣在第一次繪製之後改過，那顆球就是舊的。
    //
    // 症狀最惡劣的是串流：第一幀只有一個 identity instance，於是球在原點、
    // 半徑等於單一幾何。相機走遠之後整個物件被判定在視錐外 —— **一格都不畫，
    // 而且永遠不會恢復**。畫面上是「東西不見了」，console 一片乾淨。
    //
    // 我們自己做的是逐 instance 的精確剔除，全部看不見時就送出零次繪製。
    // 所以外面那一層物件測試本來就沒有給我們任何東西，只帶來一顆會過期的球。
    //
    // （不能改成「失效時把 boundingSphere 設成 null」—— 那會讓 Three 每次
    // 都重算一遍全部 instance 的包圍球，也就是把我們自己的熱迴圈做第二次。）
    this.frustumCulled = false;

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
    if (this.materialDetailUv !== undefined) {
      installMaterialDetail(material, { uvPerPixel: this.materialDetailUv });
    }
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
    cpuParts: { grid: number; collect: number; bake: number; spheres: number };
    /**
     * 遠景合併的槽位數、可合併的格數、最大一格有幾個 instance。
     *
     * `slots` 接近 `groups` 代表預算夠；遠小於它代表調高 `hlodBudgetMB`
     * 會讓更多遠景變成一次繪製。
     */
    hlod: {
      slots: number;
      groups: number;
      cellMax: number;
      /** 格子重建之後重新分組花的時間。與烘焙分開 —— 兩者要修的地方不同。 */
      buildMs: number;
      mergeMs: number;
      uploadMs: number;
    };
  } {
    return {
      visible: this._visibleInstances,
      tested: this._testedInstances,
      cells: this.grid.cellCount,
      visibleCells: this.grid.visibleCells,
      levels: this._levelCounts,
      spatial: this.spatialActive,
      cpuMs: this._cpuMs,
      merged: this._mergedDraws,
      mergedInstances: this._mergedInstances,
      cpuParts: {
        grid: this._gridMs,
        collect: this._collectMs,
        bake: this._bakeMs,
        spheres: this._spheresMs,
      },
      hlod: {
        slots: this._hlodSlotCount,
        groups: this._hlodGroupCount,
        cellMax: this._hlodCellMax,
        buildMs: this._hlodBuildMs,
        mergeMs: this._mergeMs,
        uploadMs: this._uploadMs,
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
    // 逐個寫入不是「整段」的形狀，區塊的包圍球就過期了。**過期的包圍球會
    // 讓一整塊憑空消失**，所以這裡作廢而不是嘗試修補。
    this.blocks.invalidate();
    this.resetBlockHlod();
    this.invalidateInstances(instanceId, instanceId + 1);
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

    // ## 遠景合併的槽位 instance 也佔 id，而使用者的 instance 必須 id === 索引
    //
    // `writeMatrices` / `setMatrixAt` 直接把索引當矩陣陣列的位置用，所以
    // `[0, capacity)` 這段 id 不能被別人插隊。槽位的 instance 住在 `capacity`
    // 之後 —— 長大時若不先把它們讓出來，新的使用者 instance 會排到槽位後面，
    // 於是總數超過 `maxInstanceCount`：**串流會直接丟出
    // 「Maximum item count reached」，整格內容不見**。
    //
    // 實測（`streaming-move`，radius 360）：78 幀裡 117 格載入失敗。
    //
    // 只還 instance，不還幾何 —— 烘好的合併幾何與它保留的緩衝區空間都留著
    // （`deleteGeometry` 不會還空間，還了就是淨損失）。Three 的 `addInstance`
    // 會優先發還回來的 id 且由小到大，所以讓出來之後使用者拿到的仍然是
    // `capacity, capacity + 1, …` 這一段連續 id。
    const slots = this.hlodSlots ?? [];
    for (const slot of slots) this.deleteInstance(slot.instanceId);
    this.setInstanceCount(target + slots.length);
    for (let i = this._capacity; i < target; i++) this.addInstance(0);
    this._capacity = target;
    for (const slot of slots) {
      slot.instanceId = this.addInstance(slot.geometryId);
      // 幾何還在，但新的 id 上還沒寫矩陣，所以當成空的。烘焙是惰性的，
      // 下一幀就會補回來 —— 而在那之前那幾格照原本逐 instance 送。
      slot.group = -1;
      slot.lastUsed = -1;
    }
    for (const group of this.hlodGroups ?? []) group.slot = -1;

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
   * 從 `start` 開始寫入一批連續的矩陣（column-major，每 16 個一組）。
   *
   * 給串流用的：一次寫幾百個時，逐個 `setMatrixAt` 會呼叫幾百次函式、
   * 標記幾百次貼圖更新。這裡是一次 `set` 加一次標記。
   */
  writeMatrices(start: number, elements: ArrayLike<number>): void {
    this.matricesArray.set(elements, start * 16);
    this.internals._matricesTexture.needsUpdate = true;
    this.lastMatrixVersion = this._instanceMatrix.version;
    const length = Math.floor(elements.length / 16);
    // 順手把這一塊的包圍球算出來。**那段記憶體本來就在手上**，所以這一趟
    // 幾乎是免費的 —— 而它省掉的是之後整份重新排序。
    const wasCovering = this.blocks.count > 0;
    this.blocks.write(this.matricesArray, start, length, this.gridRadius);
    if (this.blocks.count > 0) {
      if (!wasCovering) this.resetBlockHlod();
      this.hlodOps.push(HLOD_OP_APPEND, start, start + length);
    } else {
      this.resetBlockHlod();
    }
    this.invalidateInstances(start, start + length);
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
  moveInstances(from: number, to: number, length: number): void {
    if (length <= 0 || from === to) return;
    this.matricesArray.copyWithin(to * 16, from * 16, (from + length) * 16);
    this.internals._matricesTexture.needsUpdate = true;
    this.lastMatrixVersion = this._instanceMatrix.version;
    // ## 包圍球跟著搬，不要重算
    //
    // 矩陣是一次 `copyWithin` 搬過去的 —— 那些 instance 的**內容完全沒變**，
    // 只是換了編號。快取依編號排的時候（區塊路徑就是），同樣一次搬移就對了。
    //
    // 不搬而標髒的話，卸載一格要重算的是「洞後面的全部」，平均是半個世界。
    // 實測 490,000 個常駐時那一項是 3.8 ms/幀，而真正變動的是零個。
    if (this.shiftSpheres(from, to, length)) {
      this.blocksMoved(from, to, length);
      return;
    }
    this.blocksMoved(from, to, length);
    this.invalidateInstances(to, to + length);
  }

  /** 區塊表與分組要跟著這次搬移更新。 */
  private blocksMoved(from: number, to: number, length: number): void {
    if (this.blocks.move(from, to, length)) {
      this.hlodOps.push(HLOD_OP_DROP, to, from);
    } else {
      this.resetBlockHlod();
    }
  }

  /**
   * 把包圍球快取照同樣的方式搬過去。搬得動就回傳 true。
   *
   * 只有快取**依編號排**而且目前是乾淨的才搬得動 —— 依走訪順序排時「第幾號」
   * 對不到「第幾格」，而髒區間跨在搬移邊界上時也對不回去。那兩種情況退回
   * 標髒重算，永遠是正確的，只是慢。
   */
  private shiftSpheres(from: number, to: number, length: number): boolean {
    if (this.spheresByOrder || this.spheresAllDirty) return false;
    if (this.spheres.length < (from + length) * 4) return false;
    const delta = from - to;
    if (delta <= 0) return false;

    // 髒區間也要跟著搬。整段落在搬移範圍裡的往前移，落在洞之前的不動，
    // 跨在邊界上的對不回去 —— 那時只能整份重算。
    for (let i = 0; i < this.dirtyCount; i++) {
      const lo = this.dirtyLo[i]!;
      const hi = this.dirtyHi[i]!;
      if (hi <= to) continue;
      if (lo >= from && hi <= from + length) {
        this.dirtyLo[i] = lo - delta;
        this.dirtyHi[i] = hi - delta;
        continue;
      }
      return false;
    }

    this.spheres.copyWithin(to * 4, from * 4, (from + length) * 4);
    this.grid.invalidate();
    this.moveCount++;
    return true;
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
    // 在最前面加 —— `invalidateInstances` 會蓋這個序號，而 `prepareGrid` 要拿
    // 它判斷「這一幀之前矩陣動過嗎」。
    this.frameIndex++;

    // 使用者也可能直接寫 instanceMatrix.array —— 那條路徑不經過 setMatrixAt，
    // 所以要靠 needsUpdate 才知道格子過期了。
    if (this.instanceMatrix.version !== this.lastMatrixVersion) {
      this.lastMatrixVersion = this.instanceMatrix.version;
      this.internals._matricesTexture.needsUpdate = true;
      this.blocks.invalidate();
      this.resetBlockHlod();
      this.invalidateInstances();
    }
    // count 是普通欄位（`THREE.Mesh` 本來就有），沒有 setter 可掛，
    // 所以在這裡比對。夾在合法範圍內：越界的 count 會讓走訪讀到別人的矩陣。
    const clamped = Math.max(0, Math.min(this.count | 0, this._capacity));
    if (clamped !== this.count) this.count = clamped;
    if (clamped !== this.lastCount) {
      this.lastCount = clamped;
      // **只有格子過期，包圍球沒有。** 改 count 不會改任何一個矩陣，變多的
      // 那一段由 `ensureSpheres` 自己補上。這裡若照一般的失效走，串流就會
      // 每一幀把整份快取標髒（count 每載入一格就變一次）—— 增量等於沒做。
      this.invalidateGridOnly();
      // count 縮小時，超出去的區塊要丟掉；被切一半的區塊包圍球不再正確，
      // 那時整張表作廢。
      this.blocks.truncate(clamped);
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

    const collectStarted = performance.now();
    this.collect(ranges, ppu, bytesPerElement, multiplier);
    this._collectMs = performance.now() - collectStarted;
    // 烘在**收集之後**：這一幀想要哪幾格，收集的時候才知道。
    const bakeStarted = performance.now();
    this.serviceHlod();
    this._bakeMs = performance.now() - bakeStarted;
    this._cpuMs = performance.now() - started;
  }

  /**
   * 走訪順序表。區塊路徑用恆等表 —— 區塊不重排 instance，所以第 s 格就是
   * 第 s 號。
   */
  private get traversalOrder(): Uint32Array {
    return this.usingBlocks ? this.identityOrder : this.grid.order;
  }

  /**
   * 區塊表作廢時，跟著它建的分組也一起丟。
   *
   * 分組的 `from`/`to` 指的是走訪位置，而走訪位置在退回空間格之後是另一套
   * 編號 —— 留著就會合併到別人身上。
   */
  private resetBlockHlod(): void {
    this.hlodOps.length = 0;
    if (!this.usingBlocks && this.hlodGroups === null) return;
    this.hlodGroups = null;
    for (const slot of this.hlodSlots ?? []) {
      slot.group = -1;
      slot.lastUsed = -1;
    }
  }

  /** 恆等表長到夠用。只有區塊路徑會走到，而它只會長大。 */
  private ensureIdentityOrder(): void {
    if (this.identityOrder.length >= this.count) return;
    const size = Math.max(this.count, this.identityOrder.length * 2, 64);
    const order = new Uint32Array(size);
    for (let i = 0; i < size; i++) order[i] = i;
    this.identityOrder = order;
  }

  /** 空間格這一幀有沒有在用。宣告動態、或量到不划算而暫停都是 false。 */
  private get gridActive(): boolean {
    return this.declaredDynamic !== true && !this.gridPaused;
  }

  /** 這一幀有沒有做空間剔除 —— 不管靠的是區塊表還是空間格。 */
  private get spatialActive(): boolean {
    return this.usingBlocks || this.gridActive;
  }

  /**
   * 需要時重建空間格。
   *
   * 靜態是**宣告**出來的（`options.dynamic`），不是猜出來的。沒宣告時當靜態
   * 而且觀察；宣告過的就照宣告走，不推論。見 `InstancedMeshOptions.dynamic`。
   */
  private prepareGrid(): { bounds: Int32Array; count: number } | null {
    // ## 串流寫進來的內容已經是分好的，不必再算一次
    //
    // 一次 `writeMatrices` 就是一格的內容，寫在一段連續的編號上，而它的
    // 包圍球在寫進來的當下就順手算完了。那時建空間格是把現成的資訊丟掉
    // 再用排序重建 —— 實測 490,000 個常駐時那次重建 30 ms，而它省下的
    // 走訪只有 6.9 ms。
    //
    // 這條路不看 `dynamic`：宣告動態的意思是「別去猜、別去排序」，而區塊
    // 表兩件事都沒做。
    if (this.blocks.covers(this.count)) {
      this.usingBlocks = true;
      this.ensureIdentityOrder();
      const hlodStarted = performance.now();
      this.updateHlodForBlocks();
      this._hlodBuildMs = performance.now() - hlodStarted;
      return this.blocks.update(this.frustum, _cameraLocal.x, _cameraLocal.y, _cameraLocal.z);
    }
    this.usingBlocks = false;

    if (this.declaredDynamic === true) return null;

    // 「這一幀之前矩陣動過嗎」不能問 `grid.needsRebuild` —— 它一旦立起來就
    // 要等重建才會落下，暫停期間永遠是 true，於是永遠恢復不了。所以自己記
    // 一個失效次數，跟上一幀看到的比。
    const moving = this.moveCountSeen >= 0 && this.moveCount > this.moveCountSeen;
    this.moveCountSeen = this.moveCount;

    if (moving) {
      // **動了就把回本的帳歸零。** 回本估的是「靜下來之後不用格子每幀多花
      // 多少」，而那筆錢只有在重建出來的格子**撐得住**時才拿得回來。串流是
      // 動一幀、靜一幀交錯，累計下去就會得出「該重建了」，然後那次重建只
      // 用了一幀就作廢 —— 實測每次 30 ms，換到一幀 6.9 ms 的節省。
      if (this.gridPaused) this.gridPaybackMs = 0;
      this.weighGrid();
    } else if (this.gridPaused) {
      // ## 恢復要先把暫停時欠下的帳還完
      //
      // 原本是「有一幀沒動就立刻恢復」。串流不是每一幀都在寫矩陣（載入本身
      // 有幀預算），所以那條規則會**恢復 → 重建 → 又不划算 → 再暫停**，來回
      // 震盪。實測 490,000 個常駐：每一次重建 32 ms，而它馬上就被丟掉 ——
      // 幀 p95 **31.93 ms**，尖峰的形狀正好是一次重建。
      //
      // 恢復是要付一次重建的（暫停期間的變動讓格子過期了），所以只有在
      // 「不用格子多花的走訪」累積到超過那次重建之後才划算。兩邊都是量到的，
      // 不是幀數門檻 —— 而且真的靜下來的內容仍然會恢復，只是要等回本。
      // 從沒量到格子剔掉過任何東西時就沒有帳可算 —— 那時照舊，停下來就恢復。
      // （那也是格子本來就沒價值的情形，恢復一次的代價有限。）
      this.gridPaybackMs += this.pausedExtraMs();
      if (this.gridSkipRatio <= 0 || this.gridPaybackMs >= this.gridCostMs) {
        this.gridPaused = false;
        this.gridCostMs = 0;
        this.gridSavedMs = 0;
        this.gridPaybackMs = 0;
      }
    } else {
      this.gridCostMs = 0;
      this.gridSavedMs = 0;
      this.gridPaybackMs = 0;
    }

    if (this.gridPaused) return null;

    this.lastRebuildMs = 0;
    if (this.grid.needsRebuild) {
      const rebuildStarted = performance.now();
      this.grid.rebuild(this.matricesArray, this.count, this.gridRadius, this.instancesPerCell);
      this.lastRebuildMs = performance.now() - rebuildStarted;
      // 分開量：格子重建與遠景合併的分組是兩件事，優化方向也不同
      // （前者是排序，後者是逐 instance 的包圍球與分組）。加在一起看
      // 只會知道「這一步很慢」，不知道該修哪一邊。
      const hlodStarted = performance.now();
      this.buildHlod();
      this._hlodBuildMs = performance.now() - hlodStarted;
    }

    return this.grid.update(this.frustum, _cameraLocal.x, _cameraLocal.y, _cameraLocal.z);
  }

  /**
   * 暫停期間，這一幀因為沒有格子而多走訪掉多少時間。
   *
   * 「多走訪了幾個」用**最後一次格子真的在用時量到的剔除比例**推。那是這份
   * 內容在這台機器上的實測值，只是稍微舊了一點 —— 而它唯一的用途是決定
   * 「什麼時候值得再建一次」，不影響任何一幀的畫面。
   *
   * 沒量過（一開始就暫停）時回傳 0：那時無從得知格子有沒有用，而回本永遠
   * 不會發生反而是安全的一邊 —— 內容真的停下來時 `moving` 會是 false，
   * 那條路照樣會走到這裡，只是要等到有過一次實測。
   */
  private pausedExtraMs(): number {
    const tested = this._testedInstances;
    if (tested <= 0 || this.gridSkipRatio <= 0) return 0;
    return tested * this.gridSkipRatio * (this._collectMs / tested);
  }

  /**
   * 每幀都在重建時，判斷格子還值不值得 —— 用**剛剛量到的兩個數字**比，
   * 不是用一個我訂的幀數門檻。
   *
   * | | 從哪來 |
   * | --- | --- |
   * | 成本 | 上一幀真的花在**重建**上的時間（`lastRebuildMs`） |
   * | 省下的 | 沒被走訪到的 instance 數 × 每個 instance 的實測走訪成本 |
   *
   * 兩邊都是**這台機器上、這一份內容**的實測值，所以這個判斷在別人的機器上
   * 也成立。
   *
   * 成本只算重建，不算 `grid.update` —— 後者不管矩陣有沒有動都要付，把它算
   * 進來會讓「改了一次矩陣」的那一幀被判成不划算（相機正上方俯視、全部都在
   * 視錐裡時省下的走訪是 0，於是任何成本都贏）。要判的是**重建**值不值得。
   *
   * 累計而不是逐幀比：一幀的抖動不該推翻結論，而累計會自然地容忍短暫的變動
   * —— 矩陣一停下來就歸零，不需要另一個「連續幾幀」的門檻。這也是為什麼
   * 警告掛在這裡而不是掛在「動了」上面：改一次矩陣不是問題，帳算不過來才是。
   */
  private weighGrid(): void {
    if (this.gridPaused) return;
    const tested = this._testedInstances;
    if (tested <= 0) return;
    this.gridCostMs += this.lastRebuildMs;
    this.gridSavedMs += Math.max(this.lastCount - tested, 0) * (this._collectMs / tested);
    if (this.gridCostMs <= this.gridSavedMs) return;

    const cost = `重建花掉 ${this.gridCostMs.toFixed(2)} ms，而它省下的走訪只有 ${this.gridSavedMs.toFixed(2)} ms`;
    const advice =
      '\n真的是動態內容就宣告 `dynamic: true`。' +
      '\n只有少數 instance 在動的話，把它們拆成另一個 WW.InstancedMesh，其餘的就保得住空間分割。';

    // 宣告過 `dynamic: false` 就**不換策略** —— 那是 UE 對 Static actor 被移動
    // 的處理：警告，當成你的錯。宣告了就不猜。
    if (this.declaredDynamic === false) {
      if (this.warnedMoving) return;
      this.warnedMoving = true;
      console.warn(
        `WW.InstancedMesh: 宣告了 \`dynamic: false\`，但矩陣每幀都在變 —— ${cost}。\n` +
          '宣告過了，所以引擎不會自己換策略：格子照建，畫面正確，只是這筆錢白花。' +
          advice,
      );
      return;
    }

    this.gridPaused = true;
    if (this.warnedMoving) return;
    this.warnedMoving = true;
    console.warn(
      `WW.InstancedMesh: 已暫停空間分割剔除 —— ${cost}。\n` +
        '這批 instance 沒有宣告 `dynamic`，預設當靜態。' +
        '\n逐 instance 的視錐剔除與 LOD 仍然照常運作。矩陣**持續**停止變動、' +
        '而且不用格子多花的走訪累積到超過一次重建之後，格子會自己恢復（`stats.spatial` 讀得到）。' +
        advice,
    );
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
    this.hlodGroups = null;
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

    // 槽位一律一樣大 —— 大小不一的話回收之後就換不進去，池子會碎掉。
    // 預設是「最大那一格」，一格一個槽位。
    let maxCellInstances = 0;
    for (let cell = 0; cell < cells; cell++) {
      const size = ranges[cell * 2 + 1]! - ranges[cell * 2]!;
      if (size >= HLOD_MIN_INSTANCES && size > maxCellInstances) maxCellInstances = size;
    }
    if (maxCellInstances === 0) return;
    // ## 槽位大小用「每格的目標數」，不是「最大那一格」
    //
    // 槽位一律一樣大（不然回收之後換不進去，池子會碎掉），所以用最大那一格
    // 當尺寸時，**一個離群的大格子會把每一個槽位都撐大**。實測串流到 490,000
    // 個 instance 時整池要 373 MB，而其中大部分是永遠用不到的保留空間。
    //
    // 用目標數（`instancesPerCell`，開發者可調，預設 64）當尺寸就有上界。
    // 比目標大的格子會被切成好幾份，每一份各自合併 —— 少省一點繪製次數，
    // 但省下的記憶體是好幾倍。
    //
    // 也順便讓槽位大小**穩定**：它只跟一個宣告過的參數有關，不跟內容的
    // 離群值有關，所以串流時不會每次重建都換尺寸（換尺寸就得整池重配，
    // 而重配是淨增加 —— 見 `ensureHlodPool`）。
    const chunk = Math.max(this.hlodSlotInstances ?? this.instancesPerCell, HLOD_MIN_INSTANCES);

    const groups: HlodGroup[] = [];
    for (let cell = 0; cell < cells; cell++) {
      this.makeGroups(ranges[cell * 2]!, ranges[cell * 2 + 1]!, chunk, groups);
    }
    if (groups.length === 0) return;

    // 槽位一律保留「最大那一格」的空間，所以任何一格都放得進任何一個槽位
    // —— 大小不一的話回收之後就換不進去，池子會碎掉。
    const slotVertices = chunk * perInstance.vertices;
    const slotIndices = chunk * perInstance.indices;
    const slotBytes = slotVertices * perInstance.bytesPerVertex + slotIndices * 4;
    // ## 預設是「內容需要多少就要多少」，不是一個我訂的位元組數
    //
    // 需要的槽位數 = 可合併的格數，而那在執行時就知道，不必猜。實測一百萬
    // 個 instance：64 MB 只給 5,295 個槽位（需要 15,876），幀 46.35 ms；
    // 給滿之後 41.20 ms。而 64 那個數字沒有任何依據 —— 準則說套件裡的常數
    // 只有三種合法來源，「作者隨手訂」不是其中之一。
    //
    // 所以預設是**要多少給多少**：可合併的格數 × 一格的大小。
    //
    // 上限只是安全護欄，不是調過的值 —— 它唯一的工作是攔下荒謬的配置
    // （最粗階很重的內容會要很多）。撞到它的時候會說出來。
    this._hlodGroupCount = groups.length;
    this.hlodGroupCount = groups.length;
    this._hlodCellMax = maxCellInstances;
    this.hlodGroups = groups;
    this.hlodWanted = [];
    this.hlodSlotBytes = slotBytes;
    this.hlodSlotVertices = slotVertices;
    this.hlodSlotIndices = slotIndices;
    this.hlodChunkWanted = chunk;

    // ## 格子重建 = 槽位裡的東西全部過期
    //
    // 分組換人了，所以「第 n 個槽位裝的是第 m 格」這個對應不再成立。這件事
    // 屬於**重建**這個事件，不屬於「池子夠不夠大」—— 混在一起的話池子每幀
    // 都被清空，於是永遠烘不完（一格都合併不起來，而畫面完全正確）。
    const slots = this.hlodSlots;
    if (slots === null) return;
    if (this.hlodChunk !== chunk) {
      // 槽位變大了：舊的放不進新內容，整池作廢。空間收不回來，所以 chunk
      // 刻意取二的次方讓這件事最多發生 log₂ 次。
      for (const slot of slots) {
        this.deleteInstance(slot.instanceId);
        this.deleteGeometry(slot.geometryId);
      }
      this.hlodSlots = null;
      this._hlodSlotCount = 0;
      return;
    }
    for (const slot of slots) {
      slot.group = -1;
      slot.lastUsed = -1;
    }
  }

  /**
   * 區塊路徑下的遠景合併分組。
   *
   * ## 為什麼不能沿用「格子重建時整份重算」
   *
   * 區塊表存在的理由就是不必重建。分組若還是每次整份重算，那 22 ms 就原封
   * 不動地留在那裡（實測 490,000 個常駐時整份分組是 21–24 ms）。
   *
   * 而區塊的變動形狀是已知的：**載入是接在後面，卸載是把洞後面的往前挪**。
   * 兩者對分組的影響都是局部的 —— 前者只要替新那一段建組，後者只要刪掉那
   * 幾組、把後面的編號整體平移。都是整數工作，與世界大小無關。
   */
  private updateHlodForBlocks(): void {
    if (this.hlodOps.length === 0 && this.hlodGroups !== null) return;

    const coarsest = this.coarsestGeometry;
    if (!this.hlodEnabled || this.lodErrors.length < 2 || coarsest === null) {
      this.hlodOps.length = 0;
      return;
    }
    const chunk = Math.max(this.hlodSlotInstances ?? this.instancesPerCell, HLOD_MIN_INSTANCES);
    // 槽位大小換了就整池作廢 —— 與空間格那條路同一個規則。
    if (this.hlodChunkWanted !== chunk) {
      const perInstance = mergedSize(coarsest, 1);
      const slotVertices = chunk * perInstance.vertices;
      const slotIndices = chunk * perInstance.indices;
      this.hlodSlotVertices = slotVertices;
      this.hlodSlotIndices = slotIndices;
      this.hlodSlotBytes = slotVertices * perInstance.bytesPerVertex + slotIndices * 4;
      this.hlodChunkWanted = chunk;
    }

    // 分組要讀包圍球快取，所以順序表與快取都得先就緒。
    this.ensureSpheres();
    const groups = this.hlodGroups ?? [];

    for (let i = 0; i < this.hlodOps.length; i += 3) {
      const kind = this.hlodOps[i]!;
      const a = this.hlodOps[i + 1]!;
      const b = this.hlodOps[i + 2]!;
      if (kind === HLOD_OP_APPEND) {
        this.makeGroups(a, b, chunk, groups);
      } else {
        this.dropGroups(groups, a, b);
      }
    }
    this.hlodOps.length = 0;

    this.hlodGroups = groups;
    this._hlodGroupCount = groups.length;
    this.hlodGroupCount = groups.length;
    this._hlodCellMax = chunk;
  }

  /**
   * 刪掉落在 `[from, to)` 裡的組，並把後面的組整體往前平移。
   *
   * **槽位的反向連結要一起修。** 槽位記的是「我裝的是第幾組」，組記的是
   * 「我在第幾號槽位」。刪掉中間幾組之後編號整個位移，不修的話那些槽位會
   * 指到別人身上 —— 症狀是遠景畫成別的地方的東西，而數量完全正常。
   */
  private dropGroups(groups: HlodGroup[], from: number, to: number): void {
    const delta = to - from;
    let first = groups.length;
    let last = 0;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      if (group.from >= from && group.to <= to) {
        if (i < first) first = i;
        if (i + 1 > last) last = i + 1;
      }
    }
    const removed = Math.max(last - first, 0);

    const slots = this.hlodSlots ?? [];
    for (const slot of slots) {
      if (slot.group < 0) continue;
      if (slot.group >= first && slot.group < last) {
        // 它裝的那一組不存在了。內容作廢，槽位回到可回收狀態。
        slot.group = -1;
        slot.lastUsed = -1;
      } else if (slot.group >= last) {
        slot.group -= removed;
      }
    }

    if (removed > 0) groups.splice(first, removed);
    for (let i = first; i < groups.length; i++) {
      const group = groups[i]!;
      group.from -= delta;
      group.to -= delta;
    }
  }

  /**
   * 把 `[from, to)` 這段切成幾份，每份算出中心、半徑與最大縮放，附加到 `out`。
   *
   * 一份最多 `chunk` 個 —— 槽位一律一樣大，所以比 `chunk` 大的範圍要切開。
   * 位置用的是**已經快取好的逐 instance 包圍球**，比烘便宜好幾個數量級，
   * 而且「這一格夠不夠遠」必須在烘之前就答得出來。
   */
  private makeGroups(from: number, to: number, chunk: number, out: HlodGroup[]): void {
    const spheres = this.spheres;
    const invBaseRadius = this.boundsRadius > 0 ? 1 / this.boundsRadius : 1;
    for (let start = from; start < to; start += chunk) {
      const end = Math.min(start + chunk, to);
      // 一份只有一兩個 instance 的話，合併省不到什麼，卻照樣佔一個槽位。
      if (end - start < HLOD_MIN_INSTANCES) continue;

      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let slot = start; slot < end; slot++) {
        const s = slot * 4;
        cx += spheres[s]!;
        cy += spheres[s + 1]!;
        cz += spheres[s + 2]!;
      }
      const n = end - start;
      cx /= n;
      cy /= n;
      cz /= n;

      // 半徑取「中心到每個 instance 的球心 + 那個 instance 的半徑」的最大值
      // —— 保守地涵蓋整份。低估的方向是把不夠遠的當成夠遠，那會靜靜降低畫質。
      let radius = 0;
      let maxScale = 0;
      for (let slot = start; slot < end; slot++) {
        const s = slot * 4;
        const dx = spheres[s]! - cx;
        const dy = spheres[s + 1]! - cy;
        const dz = spheres[s + 2]! - cz;
        const r = spheres[s + 3]!;
        const reach = Math.sqrt(dx * dx + dy * dy + dz * dz) + r;
        if (reach > radius) radius = reach;
        if (r > maxScale) maxScale = r;
      }

      out.push({
        from: start,
        to: end,
        slot: -1,
        centerX: cx,
        centerY: cy,
        centerZ: cz,
        radius,
        maxScale: maxScale * invBaseRadius,
      });
    }
  }

  /**
   * 準備好槽位池。**只會長大，不會縮小。**
   *
   * ## 為什麼不能拆掉重配
   *
   * `deleteGeometry` 會還 id，但**不還緩衝區空間** —— 那是 `BatchedMesh` 的
   * 性質，不是這裡的選擇。所以「先拆掉再配一份新的」每一次都是淨增加。
   *
   * 靜態場景裡看不出來（只重建一次），串流裡是災難。實測（`streaming-move`，
   * 763 個 instance）：每次重建都重配時 GPU 記憶體三秒漲 **90 MB**，而
   * `setGeometrySize` 要複製整個緩衝區，於是空間格那一步從 0.05 ms 變成
   * **7.38 ms** 且一路變慢，幀 p50 **44.25 ms**。
   *
   * 症狀是「幀時間越跑越差」，而畫面從頭到尾完全正確 —— 一次量測都沒抓到，
   * 因為在那之前沒有任何場景會反覆重建空間格。
   *
   * ## 所以池子的生命週期與空間格脫鉤
   *
   * 格子重建只換**內容**（哪一格對到哪個槽位），不換池子。池子只在
   * 「槽位變大」或「要更多槽位」時才動，而那兩件事都是單調的。
   */
  private ensureHlodPool(coarsest: BufferGeometry, demand: number): void {
    const chunk = this.hlodChunkWanted;
    const slotBytes = this.hlodSlotBytes;
    const slotVertices = this.hlodSlotVertices;
    const slotIndices = this.hlodSlotIndices;
    if (chunk <= 0 || slotBytes <= 0) return;

    this.hlodChunk = chunk;
    const slots = this.hlodSlots ?? [];
    if (slots.length >= demand) {
      this.hlodSlots = slots;
      return;
    }

    // 目標 = 需求，但成長是倍增的 —— 每次成長都要 setGeometrySize，而那是
    // 整個緩衝區的複製。倍增讓成長次數是 log 而不是線性；2 不是調出來的，
    // 是攤還分析的標準選擇。
    const budget = this.hlodBudgetBytes ?? HLOD_DEFAULT_BUDGET_BYTES;
    const affordable = Math.floor(budget / slotBytes);
    const target = Math.min(Math.max(demand, slots.length * 2), affordable);
    this._hlodSlotCount = target;
    if (target <= slots.length) {
      // 預算擋住了。說出來 —— 靜靜少合併幾格的症狀只有幀時間。
      if (!this.warnedHlodBudget) {
        this.warnedHlodBudget = true;
        console.info(
          `WW.InstancedMesh: 遠景合併停在 ${slots.length} 個槽位 —— 這一幀想要 ${demand} 個，` +
            `而一格要 ${(slotBytes / 1048576).toFixed(2)} MB，` +
            `預算 ${(budget / 1048576).toFixed(0)} MB 只放得下 ${affordable} 個。
` +
            '多出來的那幾格照原本逐 instance 送，畫面一樣。調高 hlodBudgetMB 可以放更多。',
        );
      }
      this.hlodSlots = slots;
      return;
    }
    const add = target - slots.length;
    if (slotVertices * add > this.unusedVertexCount) {
      this.setGeometrySize(
        this.internals._maxVertexCount + slotVertices * add,
        this.internals._maxIndexCount + slotIndices * add,
      );
    }
    if (this.internals._maxInstanceCount < this._capacity + slots.length + add) {
      this.setInstanceCount(this._capacity + slots.length + add);
      // `setInstanceCount` 換掉了矩陣貼圖。之後要讀它來烘幾何，讀到舊的
      // 那一份會拿到全零的矩陣 —— 所有東西疊在原點，而且不會報錯。
      this.rebindMatrices(this._capacity);
    }

    // 佔位幾何的屬性佈局必須與其他階一致，否則 addGeometry 會拒絕。
    const placeholder = placeholderLike(coarsest);
    for (let i = 0; i < add; i++) {
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
    this.hlodSlots = slots;
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
    const coarsest = this.coarsestGeometry;
    if (groups === null || coarsest === null) return;
    if (this.hlodWanted.length === 0) return;

    // ## 池子配多大，由**這一幀真的想要幾格**決定
    //
    // 曾經是「可合併的格數」，也就是**世界有多少格**。那個數字與視野無關，
    // 而任何一刻需要合併幾何的只有看得見的遠景。實測 490,000 個 instance
    // 的串流場景：分組那一步 **339 ms**（整個空間格步驟 356 ms 的 95%），
    // 因為它一次要配七千多個槽位、三百多 MB，而同時真正想要的只有幾百格。
    //
    // 需求是這一幀觀察到的，不是我猜的 —— 而且不夠的時候只是少合併幾格，
    // 畫面一樣。
    // ## 池子要**一格一個槽位**，不是「同時看得見幾格」
    //
    // 直覺上只需要看得見的那些。實測否決了它：池子剛好等於工作集時，相機一動
    // 就有格子被踢掉再烘回來，而**每一次烘都要重傳整個批次緩衝**
    // （`setGeometryAt` 會把整個保留範圍標成 needsUpdate）。60,000 個真實資產：
    // 槽位 1024 → 540 之後 GPU **2.79 → 7.90 ms**，而繪製次數只多了 11%。
    //
    // 也就是說貴的不是「配了很多槽位」，是「槽位被回收」。穩態下一格一個槽位
    // 之後就再也不烘了，成本回到零。
    this.ensureHlodPool(coarsest, this.hlodGroupCount);
    const slots = this.hlodSlots;
    if (slots === null || slots.length === 0) return;
    // 分開量：合併運算搬得進 worker，上傳到批次幾何搬不走。兩者的比例
    // 決定搬過去值不值得 —— 加在一起看會做出錯的決定。
    this._mergeMs = 0;
    this._uploadMs = 0;

    // 實測：烘焙那一段花 1.742 ms，其中合併運算 **0.00 ms**、上傳 0.10 ms。
    // 剩下的全在找槽位。這也是「先量再做」擋下的一次錯誤決定 —— 我原本要把
    // 合併運算搬進 worker，而那一段根本不花時間。
    const order = this.traversalOrder;
    const deadline = performance.now() + this.hlodBakeMs;
    // **一幀至少烘一格。** 一格的成本可能超過整個預算（慢機器、重的最粗階），
    // 那時純看預算會永遠停在未合併的狀態 —— 而那是靜靜的效能退化。
    let baked = 0;
    let starved = false;
    for (const index of this.hlodWanted) {
      if (baked > 0 && performance.now() >= deadline) break;
      const group = groups[index];
      if (group === undefined || group.slot >= 0) continue;

      // 從上次停的地方往前找一個「這一幀沒畫到」的槽位。
      //
      // ## 只回收「這一幀沒畫到」的，不是「先來的留著」
      //
      // 試過只填空槽位、不回收 —— 池子裝不下工作集時，槽位會被暖機期那批
      // 早到的組佔住，而它們早就不在視野裡了。實測 490,000 個常駐、槽位
      // 1,365 / 7,238 組：合併次數從 248 掉到 **14**，而幀時間沒有變好。
      //
      // 所以還是回收。池子夠大時本來就沒人會被踢（穩態下全部裝得下），
      // 這條規則只影響裝不下的情形。
      //
      // 走過一圈都沒有就是真的沒有 —— 那時停手，下一幀再說。這比掃全部
      // 找最舊的便宜得多，而且**任何沒畫到的槽位都是合法的回收對象**，
      // 不必是最舊的那一個。
      //
      // 走過兩個錯的版本：掃全部再排序（穩態下每幀 1.5 ms 純浪費），以及
      // 「最多收集 32 個候選」（那等於每幀最多烘 32 格，把暖機節流成好幾倍
      // 慢：幀 25.30 → 38.05 ms）。
      let pick = -1;
      for (let probe = 0; probe < slots.length; probe++) {
        const at = (this.slotCursor + probe) % slots.length;
        const candidate = slots[at]!;
        if (candidate.group < 0 || candidate.lastUsed !== this.frameIndex) {
          pick = at;
          this.slotCursor = (at + 1) % slots.length;
          break;
        }
      }
      if (pick < 0) {
        // 每一個槽位這一幀都畫到了，卻還有格子在等 —— 這是「池子太小」的
        // **直接證據**，不是推論。下面照這個訊號把池子加倍。
        //
        // 為什麼光看「有幾格夠遠」不夠：相機一移動，下一幀想要的那幾格需要
        // 的是**這一幀沒在用**的槽位。池子剛好等於工作集時永遠找不到，於是
        // 每幀互相踢掉對方的內容 —— 實測 60,000 個真實資產：槽位 1024 掉到
        // 540 之後 GPU 2.70 → 7.87 ms，而 `merged` 兩邊都是 494 格。
        starved = true;
        break;
      }
      const slot = slots[pick]!;

      const mergeStarted = performance.now();
      const merged = mergeInstances(coarsest, this.matricesArray, order, group.from, group.to);
      this._mergeMs += performance.now() - mergeStarted;
      if (merged === null) continue;

      if (slot.group >= 0) groups[slot.group]!.slot = -1;
      const uploadStarted = performance.now();
      this.setGeometryAt(slot.geometryId, merged.geometry);
      this._uploadMs += performance.now() - uploadStarted;
      slot.count = this.internals._geometryInfo[slot.geometryId]!.count;
      slot.group = index;
      slot.lastUsed = this.frameIndex;
      merged.geometry.dispose();

      _hlodMatrix.makeTranslation(merged.center[0], merged.center[1], merged.center[2]);
      // **走 super，不走自己覆寫的那個。** 我們的 `setMatrixAt` 會把空間格
      // 標成過期 —— 標過期就變成「每幀都在改矩陣」，於是整個空間分割
      // 會被當成動態內容關掉。那個 bug 的樣子是幀時間變差而畫面完全正常。
      super.setMatrixAt(slot.instanceId, _hlodMatrix);

      baked++;
      group.slot = pick;
      group.centerX = merged.center[0];
      group.centerY = merged.center[1];
      group.centerZ = merged.center[2];
      group.radius = merged.radius;
      group.maxScale = merged.maxScale;
    }
    this.hlodWanted.length = 0;
    if (starved) this.ensureHlodPool(coarsest, slots.length + 1);
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
   * 兩者**必須一起**失效。`setMatrixAt` 不會動 `instanceMatrix.version`，
   * 所以只靠版本號判斷快取的話，用 `setMatrixAt` 的人會永遠拿到舊的包圍球
   * —— 物件搬走了，剔除與選階卻還在看原本的位置。
   */
  /** 只有空間格過期。矩陣沒動，所以包圍球快取照用。 */
  private invalidateGridOnly(): void {
    this.grid.invalidate();
    this.moveCount++;
  }

  private invalidateInstances(lo = 0, hi = Number.MAX_SAFE_INTEGER): void {
    this.invalidateGridOnly();
    if (this.spheresAllDirty) return;
    if (lo <= 0 && hi >= this._capacity) {
      this.spheresAllDirty = true;
      this.dirtyCount = 0;
      return;
    }

    // 與既有的區間合併。碰到就併，併完再看併出來的有沒有跟別人重疊 ——
    // 段數上限是 8，所以這個 O(n²) 的合併每次最多 64 步。
    let at = -1;
    for (let i = 0; i < this.dirtyCount; i++) {
      if (lo <= this.dirtyHi[i]! && hi >= this.dirtyLo[i]!) {
        this.dirtyLo[i] = Math.min(this.dirtyLo[i]!, lo);
        this.dirtyHi[i] = Math.max(this.dirtyHi[i]!, hi);
        at = i;
        break;
      }
    }
    if (at < 0) {
      if (this.dirtyCount >= SPHERE_DIRTY_RANGES) {
        this.spheresAllDirty = true;
        this.dirtyCount = 0;
        return;
      }
      this.dirtyLo[this.dirtyCount] = lo;
      this.dirtyHi[this.dirtyCount] = hi;
      this.dirtyCount++;
      return;
    }
    for (let i = this.dirtyCount - 1; i >= 0; i--) {
      if (i === at) continue;
      if (this.dirtyLo[at]! <= this.dirtyHi[i]! && this.dirtyHi[at]! >= this.dirtyLo[i]!) {
        this.dirtyLo[at] = Math.min(this.dirtyLo[at]!, this.dirtyLo[i]!);
        this.dirtyHi[at] = Math.max(this.dirtyHi[at]!, this.dirtyHi[i]!);
        this.dirtyCount--;
        this.dirtyLo[i] = this.dirtyLo[this.dirtyCount]!;
        this.dirtyHi[i] = this.dirtyHi[this.dirtyCount]!;
        if (at === this.dirtyCount) at = i;
      }
    }
  }

  private ensureSpheres(): void {
    if (this.usingBlocks) this.ensureIdentityOrder();
    const needed = this.count * 4;
    if (this.spheres.length < needed) {
      // **要把舊的搬過去。** 增量重算只算改過的那幾段，其餘的靠快取裡原本
      // 的值 —— 換一個空陣列等於把它們全部歸零，而歸零的包圍球半徑是 0，
      // 症狀是那些 instance 靜靜地被剔掉。
      const grown = new Float32Array(Math.max(needed, this.spheres.length * 2));
      grown.set(this.spheres);
      this.spheres = grown;
    }
    // **依走訪順序存，不是依 instance 編號。**
    //
    // 走訪是照空間格的順序走的（`grid.order`），所以用編號當索引時每一次
    // 讀都是陣列裡的隨機位置。一百萬個 instance 的快取是 16 MB，遠超過 L2
    // —— 實測每個 instance 從 59 ns（六萬個，快取 960 KB）惡化到 **146 ns**，
    // 同一段程式碼慢 2.5 倍，差別純粹是快取命中。
    //
    // 排成走訪順序之後就是循序讀。代價是格子重建時要跟著重排，而那本來
    // 就是同一個時機。
    // 區塊路徑的順序表是恆等的 —— 位置就是編號，所以增量那條路仍然走得通
    // （「第幾號髒了」直接對得上「快取的第幾格」）。
    const byOrder = !this.usingBlocks && this.gridActive && this.grid.order.length >= this.count;
    const previousCount = this.spheresCount;

    // ## 只重算真的改過的那幾個
    //
    // 串流每幀寫進幾百個矩陣，而整份快取是幾十萬個。實測 490,000 個常駐
    // instance：走訪 11.93 ms 裡有 **6.76 ms 是在重算包圍球**，而那一幀
    // 真正改過的不到千分之一。
    //
    // **依編號排的時候才做得到增量。** 依走訪順序排時，「第幾號髒了」對不到
    // 「快取的第幾格」—— 那需要一張反向表，是另一件事。而依編號排正好就是
    // 格子暫停時的情形，也就是串流載入中，也就是這件事最貴的時候。
    //
    // 走訪順序換人時（格子剛重建、或剛恢復）就整份重算 —— 那時每一格對應
    // 到的 instance 都變了。
    const sameLayout = this.spheresByOrder === byOrder;
    if (sameLayout && !this.spheresAllDirty && this.dirtyCount === 0 && previousCount === this.count) {
      return;
    }
    const incremental = sameLayout && !byOrder && !this.spheresAllDirty;

    this.spheresByOrder = byOrder;
    this.spheresCount = this.count;

    if (incremental) {
      // **count 變大時，多出來的那一段本來就沒算過。** 那一段通常已經在髒
      // 區間裡（串流是先寫矩陣再加 count），但不能靠那個假設。
      if (this.count > previousCount) this.computeSpheres(previousCount, this.count, false);
      if (this.dirtyCount === 0) return;
      for (let i = 0; i < this.dirtyCount; i++) {
        const from = Math.max(this.dirtyLo[i]!, 0);
        const to = Math.min(this.dirtyHi[i]!, this.count);
        if (to > from) this.computeSpheres(from, to, false);
      }
      this.dirtyCount = 0;
      return;
    }

    this.computeSpheres(0, this.count, byOrder);
    this.dirtyCount = 0;
    this.spheresAllDirty = false;
  }

  /** `[from, to)` 這幾格快取重算。`byOrder` 決定第 s 格對應哪個 instance。 */
  private computeSpheres(from: number, to: number, byOrder: boolean): void {
    const m = this.matricesArray;
    const spheres = this.spheres;
    const order = this.traversalOrder;
    const bcx = this.boundsCenter.x;
    const bcy = this.boundsCenter.y;
    const bcz = this.boundsCenter.z;
    const baseRadius = this.boundsRadius;

    for (let slot = from; slot < to; slot++) {
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
  }

  /**
   * 走訪、剔除、選階，把結果寫進 `BatchedMesh` 的繪製表。
   *
   * 這是整個類別唯一的熱迴圈。矩陣直接從 `Float32Array` 讀 —— 不建
   * `Matrix4`、不建 `Sphere`、不呼叫 `getMatrixAt`。Three.js 自己那份
   * 每個 instance 要配置一次 `Sphere` 的轉換結果，那是它最貴的部分。
   */
  private collect(
    ranges: { bounds: Int32Array; count: number; inside?: Uint8Array } | null,
    ppu: number,
    bytesPerElement: number,
    multiplier: number,
  ): void {
    const spheresStarted = performance.now();
    this.ensureSpheres();
    this._spheresMs = performance.now() - spheresStarted;
    const spheres = this.spheres;
    const invBaseRadius = this.boundsRadius > 0 ? 1 / this.boundsRadius : 1;
    const order = this.traversalOrder;
    const starts = this.internals._multiDrawStarts;
    const counts = this.internals._multiDrawCounts;
    const indirect = this.internals._indirectTexture.image.data as Uint32Array;
    const errors = this.lodErrors;
    const lodRanges = this.lodRanges;
    const levelCounts = this._levelCounts;
    const hasLod = errors.length > 1;
    const errorPixels = this.errorPixels;
    // 每階的「要多遠才用得上」係數，與 instance 無關 —— 每幀算一次。
    // 判斷式是 `errors[l] * (radius * invBaseRadius / distance) * ppu <= errorPixels`，
    // 移項成 `(errors[l] * invBaseRadius * ppu / errorPixels)² * radius² <= distance²`。
    // **先長大再取本地參照。** 反過來的話本地那份還指著舊的（長度 0）
    // 陣列，讀出來是 undefined，乘完變 NaN，比較永遠不成立 —— 症狀是
    // 所有東西都固定用第 0 階，畫面完全正常只是慢。
    if (this.levelDistanceSq.length < errors.length) {
      this.levelDistanceSq = new Float64Array(errors.length);
    }
    const levelDistanceSq = this.levelDistanceSq;
    {
      const scale = (invBaseRadius * ppu) / Math.max(errorPixels, 1e-6);
      for (let l = 0; l < errors.length; l++) {
        levelDistanceSq[l] = errors[l]! * scale * (errors[l]! * scale);
      }
    }

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
    // 整段都在視錐內側時，逐一測那六個平面是白工 —— 區塊測試已經答過了。
    const spanInside = ranges?.inside;

    for (let span = 0; span < spanCount; span++) {
      const from = bounds === undefined ? 0 : bounds[span * 2]!;
      const to = bounds === undefined ? this.count : bounds[span * 2 + 1]!;
      const skipPlanes = spanInside !== undefined && spanInside[span] === 1;

      for (let slot = from; slot < to; slot++) {
        // ── 遠景合併 ──
        //
        // 這一格整個都會挑最粗階的話，送一次合併好的幾何取代整格。
        // 遠景一個 instance 只有幾個三角形，成本幾乎全在「送出去」——
        // 一次繪製 167 ns，而那幾個三角形是 0.008 ns。
        // 池子還沒配是正常的 —— 它等到有需求才配（見 `ensureHlodPool`），
        // 所以第一幀先把想要的格子登記起來，下一步就會配好並烘。
        if (groups !== null && bounds !== undefined) {
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
              const baked = group.slot >= 0 ? slots?.[group.slot] : undefined;
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

        if (!skipPlanes) {
          let inside = true;
          for (let p = 0; p < 24; p += 4) {
            if (
              planes[p]! * cx + planes[p + 1]! * cy + planes[p + 2]! * cz + planes[p + 3]! <
              -radius
            ) {
              inside = false;
              break;
            }
          }
          if (!inside) continue;
        }

        let level = 0;
        if (hasLod) {
          // ## 同一個判斷，但沒有開根號也沒有除法
          //
          // 原本是「誤差 × 縮放 ÷ 距離 × ppu ≤ errorPixels」。把它整理成
          // 距離那一側：**誤差 × 縮放 × ppu ÷ errorPixels ≤ 距離**，兩邊
          // 平方之後距離只剩平方，開根號就不必了。
          //
          // 每階的係數與 instance 無關，所以每幀算一次（`levelDistanceSq`），
          // 迴圈裡只剩一次乘法與一次比較。挑出來的階與原本**完全相同** ——
          // 兩邊都是單調的，平方不改變大小關係（距離非負）。
          const distanceSq = cx * cx + cy * cy + cz * cz;
          const radiusSq = radius * radius;
          for (let l = errors.length - 1; l > 0; l--) {
            if (levelDistanceSq[l]! * radiusSq <= distanceSq) {
              level = l;
              break;
            }
          }
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
    // 格子真的在用的那幾幀才量得到「它剔掉了多少」。暫停之後要靠這個數字
    // 估算欠了多少帳（見 `pausedExtraMs`）。
    if (ranges !== null && this.count > 0) {
      this.gridSkipRatio = Math.max(this.count - tested, 0) / this.count;
    }
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
