/**
 * 機器 CPU 吞吐的參考量測。
 *
 * ## 這不是效能指標
 *
 * 它量的是「**這次執行時這台機器有多快**」，用來判斷兩次 benchmark 的
 * 前提是否相同。數字本身沒有意義，只有「兩次執行之間的比值」有意義。
 *
 * ## 為什麼需要
 *
 * 實測到的失效：同一份程式碼，`bench:baseline` 與 `bench` 連續執行，
 * 四個 CPU 密集場景的 `cpuFrameMs.p95` **全部乘上約 1.85 倍**：
 *
 * ```text
 * batching          5.100 →  9.605   +88%
 * cooked-assets     5.600 → 10.005   +79%
 * world-streaming   4.700 →  8.905   +90%
 * ecs-instancing   15.300 → 27.600   +80%
 * ```
 *
 * 而 CPU 輕的場景（baseline-empty 0.500 → 0.505）與**所有 GPU 指標**
 * 完全不變。隨機爭用不會讓四個場景乘上同一個倍數 —— 那是整台機器的
 * CPU 時脈在該次執行中降檔了（熱受限筆電的常態）。
 *
 * 調門檻解決不了：它不是雜訊，是**兩次量測的前提不同**。把前提量出來，
 * 比對工具就能直接說「不可比較」，而不是列出一串假退步讓人去追。
 *
 * ## 為什麼是這個工作負載
 *
 * 純整數運算、資料完全在 L1、沒有配置、沒有 DOM、沒有 GPU。它只反映
 * CPU 時脈與 IPC —— 混進記憶體或 GC 就會讓「機器狀態」與「程式碼行為」
 * 糾纏在一起，那正是要避免的。
 *
 * 取多次的**最小值**而非平均：最小值代表「這台機器最好能跑多快」，
 * 對偶發的排程干擾免疫。我們要判斷的是時脈狀態，不是當下有多忙。
 */

/** 固定的迭代次數。改動它會讓所有既有的參考值失去可比性。 */
const ITERATIONS = 2_000_000;
const REPEATS = 5;

export function measureCpuReference(): number {
  let best = Infinity;

  for (let r = 0; r < REPEATS; r++) {
    const started = performance.now();

    // xorshift + 乘法：分支少、相依鏈長，主要受時脈與 IPC 支配。
    // 用 Math.imul 確保是 32 位元整數乘法而不是浮點。
    let state = 0x9e3779b9;
    for (let i = 0; i < ITERATIONS; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state = Math.imul(state, 0x85ebca6b);
    }

    const elapsed = performance.now() - started;
    // 讀取結果避免整段迴圈被最佳化掉。JIT 會移除沒有可觀察副作用的計算，
    // 那樣量到的就會是「0ms」而不是機器速度。
    if (state === 0x7fffffff) console.debug('cpu-reference sentinel');
    if (elapsed < best) best = elapsed;
  }

  return Number(best.toFixed(3));
}

/**
 * 記憶體頻寬的參考量測。**與 `measureCpuReference` 互補，不是取代它。**
 *
 * ## 為什麼需要第二個
 *
 * `measureCpuReference` 刻意讓資料全部留在 L1，只反映時脈與 IPC。那個
 * 選擇對「整台機器降檔」是對的，但它造就了一個盲點：**記憶體頻寬劣化時
 * 它完全沒有反應**。
 *
 * 實際踩到：`ecs-instancing` 的 CPU p95 從 15.40 跳到 30.41（+97%），
 * 而同一次執行的 `cpuReferenceMs` 是 3.8 對 3.8 —— 一模一樣。比對工具
 * 因此認定兩次可比較，報出一串假退步。
 *
 * 後續四次獨立量測是 15.60 / 15.60 / 15.41 / 15.40，證實那是單次離群，
 * 程式碼沒有問題。但**閘門沒有攔下來**，那才是要修的東西。
 *
 * 十萬個 entity 的場景是在串流數 MB 的 typed array —— 它受頻寬支配，
 * 而不是 ALU。核心時脈不變但 uncore／ring 降檔、或其他行程在打 DRAM，
 * 都會讓場景變慢而整數迴圈毫無感覺。
 *
 * ## 為什麼是這個工作負載
 *
 * 緩衝區刻意開到 32 MB —— 遠大於這台機器的 L2／L3，所以每次走訪都真的
 * 打到 DRAM。步長取 16（64 位元組的快取行 ÷ 4 位元組）讓每次讀取都是
 * 一個新的快取行，硬體預取器仍然有效，量到的就是循序頻寬。
 *
 * 同樣取多次的最小值：要判斷的是「這台機器最好能跑多快」。
 */
const MEMORY_BYTES = 32 * 1024 * 1024;
const MEMORY_STRIDE = 16;
const MEMORY_REPEATS = 5;
/**
 * 每次量測掃過緩衝區幾遍。
 *
 * 單遍只要約 1.6 ms，而 `performance.now()` 量化到 0.1 ms —— 在那個量級上
 * 正常抖動就能跨過 15% 的容差。第一版就是這樣：閘門在
 * `device-loss-soak` 上報「記憶體參考 1.5ms → 1.8ms，20%」而拒絕比對，
 * 但機器根本沒事。
 *
 * **那是反向的假警報**，跟假退步一樣糟：明明沒事卻拒絕比對，一樣會
 * 訓練人忽略這個訊號。掃 16 遍讓單次量測落在約 25 ms，15% 就是 3.75 ms，
 * 那需要真的頻寬變化才跨得過去。
 */
const MEMORY_PASSES = 16;

let memoryBuffer: Int32Array | null = null;

export function measureMemoryReference(): number {
  // 緩衝區只配置一次。每次量測都重新配置的話，量到的會混進 GC 與
  // 分頁錯誤 —— 那是「當下有多忙」，不是「機器有多快」。
  if (memoryBuffer === null) {
    memoryBuffer = new Int32Array(MEMORY_BYTES / 4);
    for (let i = 0; i < memoryBuffer.length; i++) memoryBuffer[i] = i;
  }
  const data = memoryBuffer;
  let best = Infinity;

  for (let r = 0; r < MEMORY_REPEATS; r++) {
    const started = performance.now();
    let sum = 0;
    for (let pass = 0; pass < MEMORY_PASSES; pass++) {
      for (let i = 0; i < data.length; i += MEMORY_STRIDE) sum += data[i]!;
    }
    const elapsed = performance.now() - started;

    // 讀取結果避免整段迴圈被最佳化掉
    if (sum === -1) console.debug('memory-reference sentinel');
    if (elapsed < best) best = elapsed;
  }

  return Number(best.toFixed(3));
}
