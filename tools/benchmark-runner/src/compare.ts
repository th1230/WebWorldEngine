import type { BenchmarkReport } from '@ww/diagnostics';

/**
 * 回歸比對。
 *
 * 只比對「越大越糟」的指標，而且一律用 p95 而不是平均值 —— 平均值會把偶發的
 * stutter 攤平，而 stutter 正是我們最需要抓到的回歸類型。
 */

export type ComparisonStatus = 'ok' | 'regressed' | 'improved' | 'missing';

export interface ComparisonRow {
  scene: string;
  metric: string;
  baseline: number | null;
  current: number | null;
  deltaPct: number | null;
  status: ComparisonStatus;
}

export interface ComparisonResult {
  rows: ComparisonRow[];
  regressions: ComparisonRow[];
  /** 只在基準或本次結果缺少對應資料時出現，代表覆蓋範圍不完整。 */
  warnings: string[];
  passed: boolean;
}

export interface CompareOptions {
  /** 超過這個百分比才算回歸。 */
  thresholdPct: number;
  /** 覆寫所有指標的噪音下限。通常應該讓各指標用自己的預設值。 */
  minAbsolute?: number;
}

export interface MetricAccessor {
  name: string;
  get(report: BenchmarkReport): number | null;
  /**
   * 噪音下限：兩邊都低於這個值就直接視為相同。
   *
   * 這不是可有可無的保險，是必要的。Chrome 會把 `performance.now()` 量化到
   * 0.1ms，所以任何低於 1ms 的 CPU 數字，其百分比變化幾乎完全是量化誤差；
   * GPU timestamp 在次毫秒區間同樣不穩定。實測過：0.425ms → 0.822ms 會被算成
   * 「退步 93%」，但那只是兩個都約等於零的數字。
   */
  minAbsolute: number;
  /**
   * 這個指標是否以「整個顯示更新間隔」為單位跳動。
   *
   * 幀時間的 p95 是這樣的：一段執行要嘛沒掉幀（p95 ≈ p50），要嘛掉了
   * 幾幀（p95 高出整整一個間隔）。中間的值不存在，因為 present 只會在
   * vsync 邊界發生。
   *
   * 實測 `world-streaming` 在同一份程式碼下四次獨立執行的 p95：
   *
   * ```text
   * 6.30   7.90   8.40   9.91      ← p50 全部都是 6.10
   * ```
   *
   * 基準若剛好記到 6.30，之後每一次「有掉一幀」的執行都會被算成
   * 退步 57%。那不是效能變化，是同一個母體的兩個量化階。
   *
   * 所以差距小於一個更新間隔時直接視為相同 —— 對 99 ms 的
   * `material-complexity` 不痛不癢，對貼在地板上的場景才是決定性的。
   */
  quantisedByRefresh?: boolean;
}

/**
 * CPU 參考值的容許差異。
 *
 * 15% 涵蓋一般的量測抖動（實測同一狀態下的重複量測差異在 5% 以內），
 * 但遠低於降檔造成的差異（實測 85%）。設太寬就等於沒有這個檢查。
 */
const CPU_REFERENCE_TOLERANCE = 0.15;

/**
 * 記憶體參考值的容許差異，**由它自己的實測散布推導**。
 *
 * 同一份程式碼、同一台機器、五次獨立執行：
 *
 * ```text
 * 20.0   21.9   27.1   26.2   26.2      ← 全距 35.5%
 * ```
 *
 * 用 CPU 那邊的 15% 會讓閘門在多數執行上開火 —— 而**明明沒事卻拒絕比對，
 * 跟假退步一樣糟**：兩者都會訓練人忽略這個訊號。所以取「實測全距向上取整」
 * 的 40%，與 `DEFAULT_THRESHOLD_PCT` 同一套推導方式。
 *
 * ## 這讓閘門變得很粗，而且有一件事還沒驗證
 *
 * 40% 只抓得到大幅的頻寬變化。當初促成這個參考值的事件（`ecs-instancing`
 * 的 CPU p95 15.40 → 30.41）發生時**這個欄位還不存在**，所以「它會不會
 * 攔下那一次」目前**沒有證據**，只是合理推測。要驗證它，得等下一次
 * 同型事件發生時看這個值。
 *
 * 另一個讀法是：這台機器的記憶體頻寬真的在跑次之間差 35%，而那正是
 * 整段量測工作一直在對抗的場景雙峰的來源。若是如此，真正的解法是換機器
 * 或固定時脈，而不是任何門檻。這一點同樣還沒有證據。
 */
const MEMORY_REFERENCE_TOLERANCE = 0.4;

/**
 * 被回歸門檻監看的指標。
 * `variance` 指令會用同一份清單分析雜訊，確保「量的」與「擋的」是同一組東西。
 */
export const COMPARED_METRICS: readonly MetricAccessor[] = [
  {
    name: 'frameMs.p95',
    get: (r) => finite(r.timing.deltaMs.p95),
    minAbsolute: 1.0,
    quantisedByRefresh: true,
  },
  // CPU 的下限設得比其他項高：Chrome 把 performance.now() 量化到 0.1ms，
  // 一個 1.5ms 的數值光是量化就有 ±6.7% 的誤差。實測 shader-compile 的
  // cpuFrameMs 在 1.1–2.0ms 之間跳動被算成 32.9% 偏離，那全是量化雜訊。
  { name: 'cpuFrameMs.p95', get: (r) => finite(r.timing.cpuFrameMs.p95), minAbsolute: 3.0 },
  // GPU 的中位數是主要閘門：它是這組指標裡最穩定的一個。
  // `cooked-assets` 加上視錐剔除後 p50 從 46.13 降到 14.52，
  // 反向的退步同樣會被這一項立刻擋下。
  {
    name: 'gpuRenderMs.p50',
    get: (r) => (r.timing.gpuRenderMs ? finite(r.timing.gpuRenderMs.p50) : null),
    minAbsolute: 1.0,
  },
  /**
   * GPU 的 p95 下限設得高，因為它在小場景上是**雙峰**的。
   *
   * `compute-indirect` 19 次執行的實測：
   *
   * ```text
   * p50  4.48 – 5.03   （12% 全距）
   * p95  4.56 – 4.65   或   6.88 – 8.12   ← 中間完全沒有值
   * ```
   *
   * 要嘛整段執行沒有卡頓幀（p95 幾乎等於 p50），要嘛出現卡頓幀
   * （p95 高出約 3.2 ms）。那不是「雜訊散布」，是兩個不同的母體 ——
   * 而 `bench:variance` 的模型（分離系統性漂移與隨機散布）沒有涵蓋這種形態。
   *
   * 單一門檻套在雙峰指標上只會隨著落在哪一峰而隨機開關，那正是
   * 「訓練大家忽略紅燈」的最快方式。下限取 3.5 ms（實測的卡頓幅度）
   * 讓小場景的模式切換不觸發，同時 40% 的相對門檻對真正重的場景
   * （cooked-assets 14.5 ms、material-complexity 47 ms）依然有效。
   */
  {
    name: 'gpuRenderMs.p95',
    get: (r) => (r.timing.gpuRenderMs ? finite(r.timing.gpuRenderMs.p95) : null),
    minAbsolute: 3.5,
  },
  {
    name: 'peakMemoryMB',
    get: (r) => finite(r.memory.peakTotalBytes / (1024 * 1024)),
    minAbsolute: 1.0,
  },
  // 開頭數幀的總成本。整段 p95 看不出 shader 編譯這類只發生在啟動的停頓，
  // 這一項就是為了讓那種退步也擋得下來。
  {
    name: 'earlyFramesTotalMs',
    get: (r) => finite(r.earlyFrames.totalMs),
    minAbsolute: 20,
  },
];

/**
 * 預設回歸門檻，由**實測雜訊**推導而來，不是拍腦袋定的。
 *
 * 推導方式：`pnpm bench:variance` 對同一台機器上多次獨立執行的結果，先用
 * Spearman 係數把**系統性漂移**（環境在變）與**隨機散布**（量測雜訊）分開，
 * 再取「最差散布 × 2」，向上取整到 5 的倍數。漂移不參與推導 ——
 * 那類問題要修根因，任何固定門檻遲早都會被走出去。
 *
 * ## 這個數字的演變（每一步都有量測支撐）
 *
 * | 階段 | 最差散布 | 漂移 | 門檻 |
 * | --- | ---: | ---: | ---: |
 * | 單次執行、未停 shader 快取 | ~30% | — | 25% |
 * | median-of-3 + 停用 shader 快取（6 次） | 7.4% | — | 15% |
 * | 加入 ecs-instancing，排在第 3 位（5 次） | 13.3% | 4 項 | — |
 * | 場景改為由輕到重（後 4 次） | **19.4%** | **0 項** | **40%** |
 *
 * 場景重排把系統性漂移從 4 項降到 0 項 —— 重負載場景不再加熱機器之後才輪到
 * 下游場景。但單次 session 之間的隨機散布仍有 19.4%（`compute-indirect`
 * frameMs 在 15.1–18.4ms 之間跳），因此門檻必須是 40%。
 *
 * ## 40% 是個很弱的閘門，這是這台機器的限制
 *
 * 它只抓得到大幅退步。要收得更緊，必須降低 session 之間的變異：
 *
 * - 基準與比對兩邊都取**多個 session 的中位數**（成本：每次驗收 ×N）
 * - 或使用時脈穩定的機器（桌機、固定 GPU 時脈）
 *
 * 把門檻調鬆到不會誤報從來不是解法。這裡調高是因為**量到的散布真的有這麼大**，
 * 不是為了讓某次比對通過。
 *
 * 換機器或改變場景組成／順序後，必須重跑 `pnpm bench:variance` 重新推導。
 */
export const DEFAULT_THRESHOLD_PCT = 40;

export function compareReports(
  baseline: readonly BenchmarkReport[],
  current: readonly BenchmarkReport[],
  options: CompareOptions,
): ComparisonResult {
  const baselineByScene = new Map(baseline.map((r) => [r.scene, r]));
  const rows: ComparisonRow[] = [];
  const warnings: string[] = [];
  const refreshMs = refreshIntervalOf(current);

  for (const report of current) {
    const base = baselineByScene.get(report.scene);
    if (base === undefined) {
      warnings.push(`場景 ${report.scene} 沒有基準資料，無法比對（先跑 bench:baseline）`);
      continue;
    }
    baselineByScene.delete(report.scene);

    if (base.schemaVersion !== report.schemaVersion) {
      warnings.push(
        `場景 ${report.scene} 的基準是 schema v${base.schemaVersion}，本次是 v${report.schemaVersion}；` +
          `結構不同無法比對，請重新執行 pnpm bench:baseline`,
      );
      continue;
    }

    if (base.machineId !== report.machineId) {
      warnings.push(
        `場景 ${report.scene} 的基準來自另一台機器（${base.machineId} vs ${report.machineId}）；跨機器數字不可比較`,
      );
      continue;
    }

    /**
     * 同一台機器，但**當時的狀態不同**。
     *
     * 熱受限的筆電在持續負載下會降檔，而且降下去不會自己回來。實測到的
     * 形態：同一份程式碼，baseline 與 bench 連續執行，四個 CPU 密集場景的
     * `cpuFrameMs.p95` 全部乘上約 1.85 倍，而 CPU 輕的場景與所有 GPU 指標
     * 完全不變。
     *
     * 那不是雜訊 —— 隨機爭用不會讓四個場景乘上同一個倍數。它是**兩次量測
     * 的前提不同**，任何門檻都處理不了：調鬆會漏掉真的退步，調緊會天天誤報。
     *
     * 所以直接拒絕比對。列出一串假退步讓人逐一追查，比明確說「不可比較」
     * 糟糕得多。
     */
    const machineDrift = referenceDrift(base, report);
    if (machineDrift !== null) {
      warnings.push(
        `場景 ${report.scene}：機器狀態與基準不同（${machineDrift}）。` +
          '這通常是持續負載造成的降檔 —— 讓機器閒置幾分鐘後重跑，或重新產生基準。',
      );
      continue;
    }

    for (const metric of COMPARED_METRICS) {
      const baseValue = metric.get(base);
      const currentValue = metric.get(report);

      if (baseValue === null || currentValue === null) {
        rows.push({
          scene: report.scene,
          metric: metric.name,
          baseline: baseValue,
          current: currentValue,
          deltaPct: null,
          status: 'missing',
        });
        continue;
      }

      // 太小的數字算百分比只會放大量測噪音
      const minAbsolute = options.minAbsolute ?? metric.minAbsolute;
      if (baseValue < minAbsolute && currentValue < minAbsolute) {
        rows.push({
          scene: report.scene,
          metric: metric.name,
          baseline: baseValue,
          current: currentValue,
          deltaPct: 0,
          status: 'ok',
        });
        continue;
      }

      const deltaPct = ((currentValue - baseValue) / baseValue) * 100;

      // 幀時間的 p95 是**量化的**：它以整個更新間隔為單位跳動。
      // 小於一個間隔的差距代表「少掉／多掉了一幀」，不是效能變化。
      if (metric.quantisedByRefresh === true && Math.abs(currentValue - baseValue) < refreshMs) {
        rows.push({
          scene: report.scene,
          metric: metric.name,
          baseline: baseValue,
          current: currentValue,
          deltaPct,
          status: 'ok',
        });
        continue;
      }

      const status: ComparisonStatus =
        deltaPct > options.thresholdPct
          ? 'regressed'
          : deltaPct < -options.thresholdPct
            ? 'improved'
            : 'ok';

      rows.push({
        scene: report.scene,
        metric: metric.name,
        baseline: baseValue,
        current: currentValue,
        deltaPct,
        status,
      });
    }
  }

  // 基準裡有、但這次沒跑到的場景：靜默漏測比回歸更危險
  for (const scene of baselineByScene.keys()) {
    warnings.push(`基準含有場景 ${scene}，但這次沒有結果 —— 覆蓋範圍縮小了`);
  }

  const regressions = rows.filter((r) => r.status === 'regressed');
  return { rows, regressions, warnings, passed: regressions.length === 0 };
}

/**
 * 終端機以兩欄寬度顯示 CJK 字元，但 `String.padEnd` 一律算一個字元。
 * 標題含中文而資料是英文時，整張表會歪掉 —— 這是本工具最主要的人看輸出，值得對齊。
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      code >= 0x1100 &&
      (code <= 0x115f || // 韓文字母
        (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || // CJK 部首、假名、漢字
        (code >= 0xac00 && code <= 0xd7a3) || // 韓文音節
        (code >= 0xf900 && code <= 0xfaff) || // CJK 相容漢字
        (code >= 0xfe30 && code <= 0xfe6f) || // CJK 相容形式
        (code >= 0xff00 && code <= 0xff60) || // 全形
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x20000 && code <= 0x3fffd)); // 擴充漢字平面
    width += wide ? 2 : 1;
  }
  return width;
}

export function padDisplay(text: string, columns: number): string {
  return text + ' '.repeat(Math.max(0, columns - displayWidth(text)));
}

export function formatComparison(result: ComparisonResult, thresholdPct: number): string {
  const lines: string[] = [];
  const pad = padDisplay;

  const SCENE_WIDTH = 30;
  lines.push(
    `${pad('場景', SCENE_WIDTH)}${pad('指標', 18)}${pad('基準', 12)}${pad('本次', 12)}${pad('變化', 10)}狀態`,
  );
  lines.push('-'.repeat(SCENE_WIDTH + 56));

  for (const row of result.rows) {
    const symbol =
      row.status === 'regressed'
        ? '退步'
        : row.status === 'improved'
          ? '改善'
          : row.status === 'missing'
            ? '缺資料'
            : 'ok';
    lines.push(
      pad(row.scene, SCENE_WIDTH) +
        pad(row.metric, 18) +
        pad(row.baseline === null ? '-' : row.baseline.toFixed(3), 12) +
        pad(row.current === null ? '-' : row.current.toFixed(3), 12) +
        pad(
          row.deltaPct === null
            ? '-'
            : `${row.deltaPct >= 0 ? '+' : ''}${row.deltaPct.toFixed(1)}%`,
          10,
        ) +
        symbol,
    );
  }

  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('注意：');
    for (const w of result.warnings) lines.push(`  - ${w}`);
  }

  lines.push('');
  lines.push(
    result.passed
      ? `通過：沒有指標退步超過 ${thresholdPct}%`
      : `失敗：${result.regressions.length} 項指標退步超過 ${thresholdPct}%`,
  );

  return lines.join('\n');
}

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/**
 * 這台機器的顯示更新間隔，由 `baseline-empty` 的幀時間中位數推得。
 *
 * 寫死一個常數會讓門檻綁在開發機的 164Hz 上。`baseline-empty` 這個場景
 * 存在的目的就是量出「什麼都不做時能跑多快」—— 那個數字**就是**更新間隔，
 * 因為空場景一定是被 present 節流的。用它自我校準，換機器不必改程式。
 *
 * 找不到就回傳 0（等於關閉這項豁免）。寧可多報幾次假退步，
 * 也不要在拿不到校準值的機器上靜靜放寬門檻。
 */
function refreshIntervalOf(reports: readonly BenchmarkReport[]): number {
  const empty = reports.find((r) => r.scene === 'baseline-empty');
  if (empty === undefined) return 0;
  const p50 = finite(empty.timing.deltaMs.p50);
  if (p50 === null) return 0;
  // 合理性檢查：240Hz ≈ 4.2ms，30Hz ≈ 33ms。超出這個範圍代表那個場景
  // 本身出了問題，不能拿來當校準基準。
  return p50 >= 4 && p50 <= 34 ? p50 : 0;
}

/**
 * 兩次執行的機器狀態是否不同。回傳說明字串，相同則回傳 null。
 *
 * ## 為什麼需要兩個參考值
 *
 * `cpuReferenceMs` 是純整數、資料全在 L1 的迴圈 —— 它只反映時脈與 IPC。
 * 那個選擇對「整台機器降檔」是對的，但它對**記憶體頻寬劣化毫無反應**。
 *
 * 實際踩到：`ecs-instancing` 的 CPU p95 從 15.40 跳到 30.41（+97%），
 * 同一次執行的 CPU 參考值是 3.8 對 3.8 —— 一模一樣。比對因此認定可比較，
 * 報出一串假退步。後續四次獨立量測是 15.60 / 15.60 / 15.41 / 15.40，
 * 證實那是單次離群而程式碼沒問題 —— **但閘門沒有攔下來**。
 *
 * 十萬個 entity 的場景在串流數 MB 的 typed array，它受頻寬支配而不是 ALU。
 * 所以加上 `memoryReferenceMs`：32 MB 的循序讀取，遠大於快取。
 *
 * 任一個偏離就拒絕比對。兩個都要通過才算「前提相同」。
 */
function referenceDrift(base: BenchmarkReport, current: BenchmarkReport): string | null {
  const checks: Array<[string, number, number, number]> = [
    ['CPU 參考', base.cpuReferenceMs, current.cpuReferenceMs, CPU_REFERENCE_TOLERANCE],
    ['記憶體參考', base.memoryReferenceMs, current.memoryReferenceMs, MEMORY_REFERENCE_TOLERANCE],
  ];

  for (const [label, from, to, tolerance] of checks) {
    // 0 代表那一次執行沒有量到（舊的 schema）—— 不能拿來判斷，跳過。
    if (!(from > 0) || !(to > 0)) continue;
    const ratio = to / from;
    if (ratio > 1 + tolerance || ratio < 1 / (1 + tolerance)) {
      return `${label} ${from}ms → ${to}ms，${((ratio - 1) * 100).toFixed(0)}%`;
    }
  }
  return null;
}
