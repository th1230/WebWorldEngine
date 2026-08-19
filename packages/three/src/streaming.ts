import { WorldStreamer, type CellSource } from '@ww/engine';
import type { Matrix4, Object3D } from 'three';
import type { InstancedMesh } from './instanced-mesh.ts';

/**
 * 世界比記憶體大時的載入卸載。
 *
 * ```js
 * WW.worldFor(scene).stream({
 *   cellSize: 200,
 *   radius: 700,
 *   load: (cx, cz) => [{ mesh: rocks, matrix: m }, …],
 * });
 * ```
 *
 * ## 使用者只回答「這一格裡有什麼」
 *
 * 何時載入、何時卸載、先載哪一個、一幀載幾個、邊界上怎麼不抖 —— 全部是
 * 套件的事。使用者要回答的只有一個問題，而那個問題只有他答得出來。
 *
 * ## 為什麼 payload 是「已經存在的 `WW.InstancedMesh` + 矩陣」
 *
 * 使用者已經知道 `InstancedMesh` 是什麼。再發明一個 `Prefab` 或 `kind`
 * 只是讓他多學一個名字，而它表達的東西跟 `InstancedMesh` 沒有本質差別。
 *
 * 每一種內容一個 mesh（而不是每個 cell 一個）也是效能上唯一對的形狀：
 * 一次 multi-draw、一份空間格、一次 `onBeforeRender`。
 *
 * ## 為什麼 instance 會被搬動
 *
 * cell 卸載會在 instance 陣列上留下一個洞。用遮罩跳過那些槽位要在每個
 * instance 的熱迴圈裡多一次查表；把最後一塊搬進洞裡則是一次 memcpy，
 * 而且讓存活的 instance 永遠緊密排在 `[0, count)`。
 *
 * 代價是 instance 索引會變 —— 對串流的內容沒關係（使用者只回答「這格有
 * 什麼」，不持有索引），但**同一個 mesh 不要同時手動 `setMatrixAt`**。
 */

/**
 * 放一個東西進這一格。
 *
 * **矩陣會立刻被複製**，所以呼叫端可以重複使用同一個 `Matrix4` ——
 * 那是 Three.js 的慣例，也是唯一不會產生幾百個暫時物件的寫法。
 *
 * ## 為什麼是「交出去」而不是「回傳一個陣列」
 *
 * 回傳陣列的話，`[m.makeTranslation(a), m.makeTranslation(b)]` 這種寫法
 * 會讓陣列裡每一筆都指向**同一個**被改到最後一次的 `Matrix4`。
 * 症狀是整格的東西疊在同一個點上，而數量、統計、幀時間全部正常。
 *
 * 那不是使用者的錯 —— 重複使用暫存物件是 Three.js 到處都在做的事。
 * 介面應該讓正確的寫法是自然的那一個。
 */
export type PlaceFn = (mesh: InstancedMesh, matrix: Matrix4) => void;

/** 沒開原點重定位時用的常數。 */
const ZERO = { x: 0, y: 0, z: 0 };

export interface StreamStats {
  /** 目前常駐的 cell 數。 */
  resident: number;
  /** 正在載入中的 cell 數。 */
  loading: number;
  /** 排隊等待開始的 cell 數。**持續不為 0 代表載入追不上移動速度**。 */
  pending: number;
  totalLoads: number;
  totalUnloads: number;
  /** 載入失敗的次數。不為 0 就代表有 cell 永遠不會出現。 */
  failedLoads: number;
  lastError: string | null;
}

export interface StreamOptions {
  /** cell 的邊長，世界單位。 */
  cellSize: number;
  /** 相機周圍多遠以內要載入。 */
  radius: number;
  /**
   * 超過多遠才卸載。預設是 `radius` 的 1.25 倍。
   *
   * 兩者相同的話，相機停在邊界上會讓同一個 cell 反覆載入卸載 —— 每幀都在
   * 做最貴的工作，而畫面看起來完全正常。這是串流最經典的失效模式，所以
   * 這個值有下限而不是隨便給。
   */
  unloadRadius?: number;
  /**
   * 這一格裡有什麼。**必須是決定性的**：同樣的 (cx, cz) 要產生同樣的內容，
   * 否則走出去再走回來世界會變成另一個樣子。
   *
   * ```js
   * load(cx, cz, place) {
   *   for (let i = 0; i < 500; i++) place(rocks, matrix.compose(…));
   * }
   * ```
   *
   * 可以回傳 Promise —— 從網路抓內容是正常的用法。`place` 在 `await`
   * 之後仍然有效。
   */
  load(
    cellX: number,
    cellZ: number,
    place: PlaceFn,
    /**
     * 這一格多大，世界單位 —— 就是上面那個 `cellSize`。
     *
     * 傳進來而不是讓呼叫端自己記：規則式的擺放（`WW.scatter`）要用它換算
     * 密度，而「兩個地方各記一份同一個數字」遲早會不一致 —— 症狀是內容的
     * 疏密突然變了，而不是報錯。
     */
    cellSize: number,
  ): void | Promise<void>;
  /**
   * 同時進行中的載入**上限**。預設 16。
   *
   * 這是上限不是目標值：實際的併發量由自適應機制依這台機器的幀時間決定，
   * 慢的機器根本碰不到這個數字。所以它可以給得寬鬆，而**不是**一個需要
   * 作者去調的效能參數。
   */
  maxConcurrentLoads?: number;
  /**
   * 每幀的時間預算，毫秒。**預設是量出來的，不是猜的**（見下）。
   *
   * 設成 0 關閉自適應，永遠用 `maxConcurrentLoads`。
   *
   * 要傳的是**整幀的間隔**，不是 CPU 時間 —— 卡頓來自新內容進場時 GPU
   * 那一側的重新配置與上傳，只看 CPU 的話串流器會覺得自己很閒而一路加碼。
   */
  frameBudgetMs?: number;
  /**
   * 自動預算 = 這台機器的基準幀時間 × 這個倍數。預設 1.5。
   *
   * 也就是「串流不該讓一幀比這台機器自己的基準長超過 50%」。
   */
  frameBudgetSlack?: number;
  /**
   * 一格的內容進場或離場時叫一次。
   *
   * ## 為什麼需要它
   *
   * 烘好的東西（間接光探針、反射探針、全域距離場）是在**內容之前**就擺好
   * 的。世界還沒串流進來的時候，那一區的探針拍到的是空的 —— 而它會一直是
   * 空的，因為烘過的就不會再烘。
   *
   * 症狀是「這一區的反射裡少了一棟樓」「這個山谷不會變暗」，而畫面不會
   * 報錯、幀時間也完全正常。這是串流世界最典型的靜默錯誤。
   *
   * ```js
   * onCellChanged: ({ centerX, centerZ, radius }) => {
   *   probes.invalidateAround(new THREE.Vector3(centerX, 0, centerZ), radius);
   * }
   * ```
   *
   * ## 為什麼是回呼而不是直接收一個探針體積
   *
   * 串流不該知道有探針這種東西。要失效的可能是探針、可能是距離場、可能是
   * 導航網格 —— 而那份清單只有呼叫端知道。
   */
  onCellChanged?: (cell: {
    cellX: number;
    cellZ: number;
    /** 這一格中心的世界座標。 */
    centerX: number;
    centerZ: number;
    /**
     * 涵蓋這一格的半徑（含對角）—— 直接拿去當失效半徑。
     *
     * 用 `cellSize / 2` 的話四個角落沒被涵蓋到，而角落那幾顆探針
     * 剛好是「兩格交界」那些，最需要重烘。
     */
    radius: number;
    /** 進場還是離場。離場也要 —— 東西不見了，那裡的反射也該跟著變。 */
    loaded: boolean;
  }) => void;
}

/**
 * 一塊連續的 instance 範圍。
 *
 * `start` 會隨著別的 cell 卸載而**改變**，所以持有它的地方一律存這個物件
 * 的參照，不存 start 的複本 —— 存複本就會在別人先卸載之後指到別的東西上，
 * 而那個錯誤的症狀是「有時候少一叢樹」。
 */
interface Block {
  start: number;
  count: number;
}

/** 一個 cell 在各個 mesh 上佔的連續區塊。 */
interface CellBlocks {
  blocks: Array<{ mesh: InstancedMesh; block: Block }>;
}

/**
 * 一個 mesh 上的區塊清單。
 *
 * 區塊永遠緊密排在 `[0, live)`，所以 `mesh.count` 就是存活數，
 * 熱迴圈完全不必知道串流的存在。
 */
class MeshBlocks {
  live = 0;
  readonly blocks: Block[] = [];
}

export class WorldStream {
  private readonly streamer: WorldStreamer<CellBlocks>;
  private readonly perMesh = new Map<InstancedMesh, MeshBlocks>();
  private readonly load: StreamOptions['load'];
  private readonly onCellChanged: StreamOptions['onCellChanged'];
  private readonly cellSize: number;
  private lastFrameTime = 0;

  private readonly fixedBudgetMs: number | undefined;
  private readonly slack: number;
  /**
   * 這台機器**自己的**基準幀時間。
   *
   * ## 為什麼不能給一個預設數字
   *
   * 「一幀不要超過 16.7 ms」在 60 Hz 的桌機上是對的，在 144 Hz 上太鬆、
   * 在弱機器上永遠達不到（於是併發被砍到 1，內容一路落後）。作者猜的
   * 任何數字都是**替某一台機器調校**。
   *
   * 對的值是這台機器安靜時的幀間隔，而那只有在使用者的機器上跑起來才
   * 量得到。
   *
   * 取的是最近 120 幀的 **p25**，不是最小值 —— 最小值會被單一異常的快幀
   * 綁架，而且再也上不來。整段理由見 `observeFrame`。
   */
  private baselineMs = Infinity;

  /**
   * 目前的原點在世界座標的哪裡。由 `World` 提供，預設是零。
   *
   * 見 `place` 裡那一段：這是**大世界精度**的另外一半。
   */
  private origin: () => { x: number; y: number; z: number } = () => ZERO;

  /** @internal `World` 開串流時把原點接進來。 */
  useOrigin(origin: () => { x: number; y: number; z: number }): void {
    this.origin = origin;
  }

  constructor(options: StreamOptions) {
    this.load = options.load;
    this.onCellChanged = options.onCellChanged;
    this.cellSize = options.cellSize;
    const unloadRadius = options.unloadRadius ?? options.radius * 1.25;

    const source: CellSource<CellBlocks> = {
      load: (cx, cz) => this.loadCell(cx, cz),
      unload: (cx, cz, cells) => {
        for (const cell of cells) this.releaseCell(cell);
        this.announce(cx, cz, false);
      },
    };

    this.fixedBudgetMs = options.frameBudgetMs;
    this.slack = options.frameBudgetSlack ?? 1.5;

    this.streamer = new WorldStreamer<CellBlocks>(source, {
      cellSize: options.cellSize,
      loadRadius: options.radius,
      unloadRadius,
      maxConcurrentLoads: options.maxConcurrentLoads ?? 16,
      // 先給一個非零值把自適應打開，真正的預算在第一次觀察到幀時間之後
      // 就被換掉。給 0 的話 `reportFrameMs` 會直接 return，永遠不啟動。
      frameBudgetMs: options.frameBudgetMs ?? Number.MAX_SAFE_INTEGER,
    });
  }

  /**
   * 串流目前的狀況。
   *
   * 這是**對外自己的型別**，不是內部 `WorldStreamer` 的那個 —— 兩個理由：
   * 發布出去的 `.d.ts` 不該引用一個 npm 上不存在的內部套件；而且對外該講
   * 的東西比內部少（代理層、取消計數是實作細節）。
   */
  get stats(): StreamStats {
    const s = this.streamer.stats;
    return {
      resident: s.resident,
      loading: s.loading,
      pending: s.pending,
      totalLoads: s.totalLoads,
      totalUnloads: s.totalUnloads,
      failedLoads: s.failedLoads,
      lastError: s.lastError,
    };
  }

  /**
   * 每幀推進一次。由 `World` 掛在 `scene.onBeforeRender` 上呼叫。
   *
   * `now` 用來回報上一幀的間隔給自適應預算。第一幀沒有「上一幀」，所以
   * 跳過 —— 把 0 當成間隔會讓串流器以為機器快得不得了。
   */
  update(cameraX: number, cameraZ: number, now: number): void {
    if (this.lastFrameTime !== 0) {
      const frameMs = now - this.lastFrameTime;
      if (this.fixedBudgetMs === undefined) {
        this.observeFrame(Math.max(frameMs, 1e-3));
        this.streamer.setFrameBudgetMs(this.baselineMs * this.slack);
      }
      this.streamer.reportFrameMs(frameMs);
    }
    this.lastFrameTime = now;
    this.streamer.update(cameraX, cameraZ);
  }

  /**
   * 記一幀，並更新「這台機器的基準」。
   *
   * ## 為什麼不是取最小值
   *
   * 第一版是 `baselineMs = min(baselineMs * 1.001, frameMs)` —— 想法是「取最快
   * 的那一幀當基準，再讓它每幀放寬 0.1%，這樣機器變慢了也跟得上」。
   *
   * 那個 `min` 把放寬完全吃掉了：**只要之後再出現一幀很快的，基準就被壓回去**。
   * 而「很快的一幀」隨時會發生 —— 分頁剛載入、rAF 補送兩次、瀏覽器打嗝之後
   * 連著兩幀。於是基準黏在那一幀上，永遠不再上來。
   *
   * 實測（串流、每秒 600 單位）：基準 0.74–0.86 ms，而**取樣視窗裡最快的一幀
   * 是 5.60 ms、p50 是 6.10 ms**。預算 = 基準 × 1.5 ≈ 1.2 ms，任何真實的幀都
   * 超過它，所以載入速率被一路砍到底、**永遠停在 1**。
   *
   * 那不是「自適應在保護幀率」，那是自適應**壞掉之後剛好卡在最保守的一端**。
   * 症狀是世界填得比這台機器實際做得到的慢很多，而畫面完全正常、沒有任何錯誤
   * ——正是最難發現的那一種。
   *
   * ## 為什麼是 p25，不是中位數
   *
   * 中位數會**自己往上飄**：載入讓幀變慢 → 中位數上升 → 預算變寬 → 載入更多。
   * 那是一個正回饋。
   *
   * p25 貼近「沒在載入時的幀」（載入的幀是比較慢的那一半），又不像最小值那樣
   * 被單一異常值綁架。視窗 120 幀 ≈ 兩秒，夠久到蓋過打嗝，夠短到跟得上降頻。
   */
  private observeFrame(frameMs: number): void {
    this.frameWindow[this.frameCursor % this.frameWindow.length] = frameMs;
    this.frameCursor++;
    // 每 15 幀才重算一次。基準不需要每幀精確，而排序 120 個數字每幀都做是白花的。
    if (this.frameCursor % 15 !== 0 && Number.isFinite(this.baselineMs)) return;
    const filled = Math.min(this.frameCursor, this.frameWindow.length);
    const sorted = Array.from(this.frameWindow.subarray(0, filled)).sort((a, b) => a - b);
    this.baselineMs = sorted[Math.floor(filled * 0.25)] ?? sorted[0] ?? 1e-3;
  }

  /** 最近的幀間隔。基準取它的 p25 —— 見 `observeFrame`。 */
  private readonly frameWindow = new Float64Array(120);
  private frameCursor = 0;

  /** 目前用的幀預算與這台機器的基準。沒有這個就沒辦法判斷自適應有沒有生效。 */
  get budget(): { baselineMs: number; budgetMs: number; loadRate: number } {
    const baselineMs = Number.isFinite(this.baselineMs) ? this.baselineMs : 0;
    return {
      baselineMs,
      budgetMs: this.fixedBudgetMs ?? baselineMs * this.slack,
      loadRate: this.streamer.loadRate,
    };
  }

  /**
   * 跑一次 `load`，把它交出來的東西收進暫存，然後一次配置、一次寫入。
   *
   * ## 為什麼要暫存而不是邊收邊寫
   *
   * `load` 可以是非同步的，而同時可能有好幾格在載入。邊收邊寫的話，
   * 兩格的 `place` 會交錯，於是同一格的 instance 不再連續 —— 而卸載
   * 是靠「一段連續範圍」做的。
   *
   * 暫存的代價是每一格一次配置。它是暫時的，而且與同時在飛的載入數
   * 成正比，不與世界大小成正比。
   */
  /**
   * 告訴呼叫端這一格變了。
   *
   * 半徑用**對角**（cellSize × √2 ÷ 2）而不是半邊長：格子四個角落那幾顆
   * 探針剛好是兩格交界處的，最需要重烘，而半邊長涵蓋不到它們。
   */
  private announce(cellX: number, cellZ: number, loaded: boolean): void {
    if (this.onCellChanged === undefined) return;
    this.onCellChanged({
      cellX,
      cellZ,
      centerX: (cellX + 0.5) * this.cellSize,
      centerZ: (cellZ + 0.5) * this.cellSize,
      radius: this.cellSize * Math.SQRT1_2,
      loaded,
    });
  }

  private async loadCell(cx: number, cz: number): Promise<CellBlocks[]> {
    const staged = new Map<InstancedMesh, number[]>();
    // ## 這裡是大世界精度的另外一半
    //
    // 原點重定位修的是「相機與世界都很大時，兩者相減掉精度」——也就是畫面
    // 在抖。但**內容寫進來的那一刻**還有另一次損失：使用者用世界座標描述
    // 這一格有什麼（那是唯一自然的寫法），而矩陣最後存進 `Float32Array`。
    // 在 200,000 那裡，float32 的間距是 0.0156 —— 公分級的擺放全毀。
    //
    // 而這裡正好是最後一個還是 double 的地方：`buffer` 是普通的 JS 陣列。
    // 在轉成 float32 之前先減掉原點，存進去的就是一個小數字。
    //
    // 於是使用者那一側完全不必知道原點的存在：他照世界座標寫，引擎負責
    // 讓它存得下。
    const place: PlaceFn = (mesh, matrix) => {
      let buffer = staged.get(mesh);
      if (buffer === undefined) staged.set(mesh, (buffer = []));
      const at = buffer.length;
      matrix.toArray(buffer, at);
      const origin = this.origin();
      buffer[at + 12]! -= origin.x;
      buffer[at + 13]! -= origin.y;
      buffer[at + 14]! -= origin.z;
    };

    await this.load(cx, cz, place, this.cellSize);
    if (staged.size === 0) return [];

    const cell: CellBlocks = { blocks: [] };
    for (const [mesh, buffer] of staged) {
      const count = buffer.length / 16;
      const state = this.stateOf(mesh);
      const start = state.live;
      mesh.ensureCapacity(start + count);
      mesh.writeMatrices(start, buffer);
      state.live += count;
      mesh.count = state.live;

      const block: Block = { start, count };
      state.blocks.push(block);
      cell.blocks.push({ mesh, block });
    }

    // ## 通知放在這裡，不是放在呼叫端包一層
    //
    // 兩個理由。一是**內容寫進去之後**才通知：反過來的話收到通知的人去
    // 重烘，拍到的還是舊的世界，而那正是這個回呼要解決的問題。
    //
    // 二是包一層 async 會多插一個 microtask，而串流器的完成處理是照
    // microtask 排的 —— 實測直接讓一條既有的測試變紅（「慢的那幾格回來
    // 之後接得上」等的是固定的兩個 tick）。時序不是實作細節。
    //
    // 上面那條「這一格沒東西」的早退不會走到這裡，那是對的：真的沒有內容
    // 就沒有東西需要重烘。
    this.announce(cx, cz, true);
    return [cell];
  }

  /**
   * 釋放一個 cell 佔的所有區塊。
   *
   * 作法是把後面所有存活的 instance 往前壓，蓋掉這個洞。那會動到後面每一
   * 塊的 `start`，所以區塊本身必須是**共享的物件**而不是複本 —— 存複本
   * 的話，後續的卸載會搬錯範圍，而症狀是「有時候少一叢樹」。
   *
   * 用整段前壓而不是「把最後一塊搬過來」：後者只在兩塊一樣大時成立，
   * 而 cell 的內容量本來就不一樣。前壓是一次 `copyWithin`，成本相同。
   */
  private releaseCell(cell: CellBlocks): void {
    for (const { mesh, block } of cell.blocks) {
      const state = this.perMesh.get(mesh);
      if (state === undefined) continue;

      const index = state.blocks.indexOf(block);
      if (index < 0) continue;

      const tail = state.live - block.start - block.count;
      if (tail > 0) {
        mesh.moveInstances(block.start + block.count, block.start, tail);
        for (const other of state.blocks) {
          if (other.start > block.start) other.start -= block.count;
        }
      }

      state.blocks.splice(index, 1);
      state.live -= block.count;
      mesh.count = state.live;
    }
    cell.blocks.length = 0;
  }

  private stateOf(mesh: InstancedMesh): MeshBlocks {
    let state = this.perMesh.get(mesh);
    if (state === undefined) {
      state = new MeshBlocks();
      this.perMesh.set(mesh, state);
      // 串流接管之後，這個 mesh 的存活數由 cell 決定。使用者建構時給的
      // 容量變成初始配置量，不是「畫幾個」。
      mesh.count = 0;
    }
    return state;
  }
}

/** `Object3D.onBeforeRender` 的形狀，只取我們用得到的部分。 */
export type SceneRenderHook = (
  renderer: unknown,
  scene: Object3D,
  camera: { matrixWorld: { elements: ArrayLike<number> } },
) => void;
