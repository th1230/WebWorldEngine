import type { BenchmarkReport } from '@ww/diagnostics';
import { chromium, type Browser, type Page } from 'playwright';
import { build, preview, type PreviewServer } from 'vite';
import { APP_ROOT } from './paths.ts';

/**
 * 兩種執行 profile，結果**絕不可混用**。
 *
 * hardware：有頭模式、真實 GPU。只有這個模式的數字能當效能基準。
 * smoke   ：無頭 + SwiftShader 軟體 adapter。只驗證「跑不跑得起來、有沒有正確
 *           降級」，效能數字毫無意義 —— 所以結果寫到不同目錄，也不會被
 *           bench:compare 拿來當基準。
 */
export interface RunProfile {
  id: string;
  headless: boolean;
  args: string[];
  description: string;
  /** 這個 profile 的數字是否可作為效能基準。 */
  performanceMeaningful: boolean;
}

/**
 * 停用 GPU shader 快取。
 *
 * 這是為了**可重現性**，不是為了模擬最差情況。驅動會把編譯好的 shader 存到
 * 磁碟並跨瀏覽器行程重用，於是「第一次編譯」一輩子只發生一次：
 * shader-compile-cold 第一次量到 17,314ms，之後每次都只有 1,684ms —— 差了十倍，
 * 而且差異來自機器上的殘留狀態，不是程式碼。
 *
 * 代價是所有場景的開頭數幀都會比真實使用者（第二次開啟）略慢。這個代價值得付：
 * 隱藏的狀態依賴會讓基準悄悄失效，而那比數字偏保守嚴重得多。
 */
const NO_SHADER_CACHE = ['--disable-gpu-shader-disk-cache', '--disable-gpu-program-cache'];

export const PROFILES: Record<string, RunProfile> = {
  hardware: {
    id: 'hardware',
    headless: false,
    args: ['--enable-unsafe-webgpu', ...NO_SHADER_CACHE],
    description: '有頭 Chrome + 真實 GPU。基準數據唯一來源。',
    performanceMeaningful: true,
  },
  smoke: {
    id: 'smoke',
    headless: true,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      '--disable-gpu-sandbox',
      ...NO_SHADER_CACHE,
    ],
    description: '無頭 + SwiftShader。只做「有沒有壞掉」的煙霧測試，效能數字不可用。',
    performanceMeaningful: false,
  },
};

/** GPU 記憶體在單次執行內成長超過這個量就提出警告。 */
const MEMORY_DRIFT_WARN_MB = 8;

/**
 * 量測前的預熱秒數。
 *
 * 60 秒是量出來的下限：實測重負載場景在連續負載約 20 分鐘後從
 * 15ms 階躍到 28ms，而預熱要做的是讓**兩邊都**處在階躍之後的狀態。
 * 太短會落在階躍前，等於沒做。
 */
const DEFAULT_SOAK_SECONDS = 60;

export interface SceneRun {
  id: string;
  /** 報告中使用的鍵。同一場景不同參數時用來區分。 */
  label?: string;
  warmup: number;
  frames: number;
  params?: Record<string, string>;
  /**
   * smoke profile 專用的縮小版設定。
   *
   * 煙霧測試問的是「會不會壞」，不是「多快」。用硬體規模的工作量去跑軟體
   * adapter 只會逾時 —— 那不是有意義的失敗訊號，只是浪費 CI 時間。
   */
  smoke?: { warmup?: number; frames?: number; params?: Record<string, string> };
  /**
   * 限定只在這些 profile 執行。省略代表全部都跑。
   *
   * 存在的理由是「有些檢查在軟體 adapter 上**無法**進行」，而不是
   * 「在軟體 adapter 上比較慢」—— 後者用 `smoke` 縮小工作量就好。
   * 前者若照跑，得到的失敗訊號沒有意義，反而會訓練人忽略 CI 的紅燈。
   */
  profiles?: readonly string[];
}

/**
 * 執行順序：**由輕到重**。
 *
 * 這個順序是量出來的。原本把最重的場景排在第 3 位，
 * 五次獨立執行的分析顯示下游場景的隨機散布從 7.4% 惡化到 13.3%，
 * 且多項指標呈現單調漂移 —— 重負載場景把機器加熱之後才輪到別人跑。
 *
 * 把耗時最長的排到最後，可以讓大多數場景在相對一致的熱狀態下量測。
 * 這改善不了最後那幾個場景自己的條件，但至少不會污染其他八個。
 *
 * 改動順序會讓既有基準失效，必須重跑 `pnpm bench:baseline`。
 */
export const DEFAULT_RUNS: readonly SceneRun[] = [
  { id: 'baseline-empty', warmup: 60, frames: 300, smoke: { warmup: 20, frames: 60 } },
  // shader-compile 盡量排在前面：它量的是編譯成本，越接近冷啟動越有代表性
  {
    id: 'shader-compile',
    label: 'shader-compile-cold',
    warmup: 0,
    frames: 200,
    params: { precompile: '0' },
    smoke: { frames: 30, params: { precompile: '0', count: '12', minChain: '8', chainSpread: '8' } },
  },
  {
    id: 'shader-compile',
    label: 'shader-compile-precompiled',
    warmup: 0,
    frames: 200,
    params: { precompile: '1' },
    smoke: { frames: 30, params: { precompile: '1', count: '12' } },
  },
  {
    id: 'texture-load',
    warmup: 60,
    frames: 300,
    smoke: { warmup: 10, frames: 40, params: { count: '8', size: '128' } },
  },
  {
    id: 'device-loss-soak',
    warmup: 30,
    frames: 900,
    params: { interval: '40', losses: '20' },
    smoke: { warmup: 5, frames: 120, params: { interval: '20', losses: '5' } },
  },
  {
    id: 'compute-indirect',
    warmup: 120,
    frames: 600,
    smoke: { warmup: 10, frames: 40, params: { count: '2000', spread: '80' } },
  },
  {
    id: 'batching',
    warmup: 120,
    frames: 600,
    smoke: { warmup: 10, frames: 40, params: { count: '500', spread: '60' } },
  },
  // ── 以下是重負載，排在最後避免污染上面的場景 ──
  {
    id: 'instancing',
    warmup: 120,
    frames: 600,
    smoke: { warmup: 10, frames: 40, params: { count: '2000', spread: '80' } },
  },
  // ── W1 的 A/B：THREE.InstancedMesh 對 WW.InstancedMesh ──────────────────
  //
  // **這兩筆必須相鄰。** 上面的迴圈是 `for 每一輪 { for 每個場景 }`，相鄰
  // 就代表同一輪裡背靠背執行、輪與輪之間交替。這台機器的量測是雙峰的，
  // 連續跑完一組再跑另一組會拿兩個不同母體在比，結論可以完全相反。
  //
  // 兩者除了那一個類別以外完全相同：同一個種子的矩陣、同一條相機路徑、
  // 同一份材質與燈光。差異若不只一項，量到的差就不知道是誰造成的。
  {
    id: 'ab-native-instanced',
    warmup: 120,
    frames: 600,
    smoke: { warmup: 10, frames: 40, params: { count: '2000', spread: '120' } },
  },
  {
    id: 'ab-ww-instanced',
    warmup: 120,
    frames: 600,
    smoke: { warmup: 10, frames: 40, params: { count: '2000', spread: '120' } },
  },
  // ── 同一個 A/B，換成真實資產 ────────────────────────────────────────────
  //
  // 上面那一組的內容在兩個方向上都不具代表性：`IcosahedronGeometry` 是非索引
  // 的（幾何看起來貴 3.35 倍），而且沒有貼圖（材質看起來免費，真實 PBR 是
  // 1.72 倍）。沒有這一組的話，「該修哪一端」是拿錯的內容決定的。
  //
  // 需要先跑 `pnpm cook:real`。資產不在時這兩個場景會**明確失敗**，不會
  // 靜靜退回程序化內容。
  //
  // smoke 不跑：CI 沒有真實資產（二進位美術檔不進版控）。
  {
    id: 'ab-native-real',
    warmup: 120,
    frames: 600,
    profiles: ['hardware'],
  },
  {
    id: 'ab-ww-real',
    warmup: 120,
    frames: 600,
    profiles: ['hardware'],
  },
  // ── 遮擋：Sponza 中庭 ────────────────────────────────────────────────
  //
  // 唯一有東西擋住東西的場景。先前否決遮擋剔除的那次是用一片散開的石頭
  // 量的，那種內容裡根本沒有遮擋可言。
  //
  // 看的是拆解（三角形與繪製次數各佔多少），不是幀時間本身。
  // 需要 pnpm cook:sponza。
  {
    id: 'occlusion-sponza',
    warmup: 120,
    frames: 300,
    profiles: ['hardware'],
  },
  // ── 天花板：兩端各自的上限 ──────────────────────────────────────────────
  // 這三個的**幀時間本身沒有意義**。它們刻意把一端壓到零去量另一端，
  // 有意義的是 verdict 裡的「每毫秒多少」。W4 的每一個優化都要對照它們。
  {
    id: 'ceiling-cpu',
    warmup: 120,
    frames: 600,
    smoke: { warmup: 10, frames: 40, params: { count: '5000', spread: '200' } },
  },
  {
    id: 'ceiling-gpu-triangles',
    warmup: 120,
    frames: 300,
    smoke: { warmup: 10, frames: 40, params: { count: '500', detail: '4' } },
  },
  // 這兩筆也必須相鄰、也必須是同一份工作量。「每毫秒幾次繪製」單獨看沒有
  // 意義 —— 那段時間裡也包含頂點、光柵化與 present。相減才是繪製呼叫自己
  // 的價碼，而那正是 W4 機制層要不要做繪製合併的依據。
  {
    id: 'ceiling-gpu-drawcalls',
    label: 'ceiling-gpu-drawcalls-many',
    warmup: 120,
    frames: 300,
    params: { mode: 'many' },
    smoke: { warmup: 10, frames: 40, params: { count: '2000' } },
  },
  {
    id: 'ceiling-gpu-drawcalls',
    label: 'ceiling-gpu-drawcalls-one',
    warmup: 120,
    frames: 300,
    params: { mode: 'one' },
    smoke: { warmup: 10, frames: 40, params: { count: '2000' } },
  },
  {
    id: 'material-complexity',
    warmup: 60,
    frames: 300,
    smoke: { warmup: 10, frames: 40, params: { iterations: '4', layers: '2' } },
  },
  // 正確性檢查，不是效能量測 —— 它不畫任何東西，數字沒有意義，看的是 verdict。
  // 放在最後：它會自己開一個 GPUDevice，排在前面會影響後續場景的量測條件。
  // 只在 hardware 跑：smoke 用的 SwiftShader 連 WebGPU adapter 都拿不到
  // （實測 `requestAdapter()` 回傳 null，fallback adapter 也一樣），
  // 沒有硬體解碼器就沒有裁判，跑了只會得到一個必然的失敗。
  //
  // 因此這個場景的 verdict 維持嚴格：**驗不到任何格式就算失敗**。
  // 有那條規則，「BC 支援消失」這種真實的環境退化才不會被當成正常。
  {
    id: 'texture-conformance',
    warmup: 0,
    frames: 30,
    profiles: ['hardware'],
  },
];

/** 依 profile 套用對應的工作量。 */
export function runsForProfile(runs: readonly SceneRun[], profile: RunProfile): SceneRun[] {
  const applicable = runs.filter((run) => run.profiles === undefined || run.profiles.includes(profile.id));
  if (profile.performanceMeaningful) return applicable.map((run) => ({ ...run }));
  return applicable.map((run) => ({
    ...run,
    warmup: run.smoke?.warmup ?? run.warmup,
    frames: run.smoke?.frames ?? run.frames,
    params: { ...run.params, ...run.smoke?.params },
  }));
}

export interface RunOptions {
  profile: RunProfile;
  runs?: readonly SceneRun[];
  /** 單一場景的逾時。device-loss-soak 會慢很多。 */
  timeoutMs?: number;
  /**
   * 每個場景重複幾次，取中位數。
   *
   * 單次執行不足以判定回歸：在 基準機器上，相同程式碼連跑兩次，batching
   * 場景的 frame p95 就有約 30% 的差異（內顯時脈隨散熱與電源狀態變動）。
   * 取中位數能壓掉大部分這類雜訊，代價是執行時間乘上 N。
   */
  repeat?: number;
  /** 量測前的預熱秒數。0 代表不預熱（只有在確知機器不會降檔時才該這麼做）。 */
  soakSeconds?: number;
  onProgress?: (message: string) => void;
}

export interface RunOutcome {
  reports: BenchmarkReport[];
  failures: Array<{ scene: string; error: string }>;
}

interface HarnessStateShape {
  phase: string;
  report: BenchmarkReport | null;
  error: string | null;
  framesDone: number;
}

export async function runBenchmarks(options: RunOptions): Promise<RunOutcome> {
  const runs = runsForProfile(options.runs ?? DEFAULT_RUNS, options.profile);
  const timeoutMs = options.timeoutMs ?? 180_000;
  const repeat = Math.max(1, Math.floor(options.repeat ?? 1));
  const log = options.onProgress ?? ((m: string) => console.log(m));

  log(`建置 benchmark app（正式建置，不用 dev server —— dev 模式的模組載入會混進數字裡）…`);
  await build({ root: APP_ROOT, logLevel: 'warn' });

  let server: PreviewServer | null = null;
  let browser: Browser | null = null;
  const reports: BenchmarkReport[] = [];
  const failures: Array<{ scene: string; error: string }> = [];

  try {
    server = await preview({ root: APP_ROOT, logLevel: 'warn' });
    const baseUrl = server.resolvedUrls?.local[0];
    if (baseUrl === undefined) throw new Error('preview server 沒有回報可用網址');
    log(`preview server: ${baseUrl}`);

    browser = await launchBrowser(options.profile);

    /**
     * 量測前先把機器跑到穩態。
     *
     * ## 為什麼需要
     *
     * 筆電/內顯在持續負載下會觸發功耗上限並**降檔**，而且降下去就不再回來。
     * 於是「先跑 baseline 再跑 bench」這個看似無害的順序，會系統性地讓
     * bench 在較低的時脈下量測。
     *
     * 實測到的形態（同一份程式碼，baseline 與 bench 連續執行）：
     *
     * ```text
     * ecs-instancing   baseline  15.40  15.20  15.30   ← 極穩
     *                  bench     15.00  27.30  28.31   ← 第 2 輪起階躍，不再恢復
     * batching         bench     13.40  15.30  17.00   ← 單調上升
     * ```
     *
     * 那不是隨機雜訊而是**階躍後持續**，所以交錯排列救不了 —— 干擾持續
     * 超過三次重複中的兩次，中位數照樣被污染。
     *
     * ## 為什麼是「預熱」而不是「冷卻」
     *
     * 等機器冷卻要花很久，而且量到的是「剛開始的高時脈」—— 那不是使用者
     * 玩十分鐘之後看到的效能。讓兩邊都在**穩態**下量測，數字才可比較，
     * 而且更接近真實。
     *
     * 用最重的場景預熱，才確保真的進到降檔狀態。
     */
    const soakSeconds = options.soakSeconds ?? DEFAULT_SOAK_SECONDS;
    if (soakSeconds > 0 && options.profile.performanceMeaningful) {
      log(`預熱 ${soakSeconds}s（讓時脈進入穩態，否則先跑的那一輪會系統性地偏快）…`);
      const soakRun: SceneRun = {
        id: 'material-complexity',
        warmup: 0,
        frames: Math.max(60, Math.round(soakSeconds * 30)),
      };
      const soakStarted = Date.now();
      try {
        while ((Date.now() - soakStarted) / 1000 < soakSeconds) {
          await runOne(browser, baseUrl, soakRun, timeoutMs, () => {});
        }
      } catch (error) {
        // 預熱失敗不該讓整輪驗收停下來，但要說出來 —— 少了預熱的數字
        // 與有預熱的不可比較。
        log(`  ⚠ 預熱失敗，數字可能偏樂觀：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    /**
     * 重複是**交錯**執行的：`輪1(全部場景) → 輪2(全部場景) → 輪3(全部場景)`，
     * 而不是「場景 A 連跑三次，再換場景 B」。
     *
     * 這不是風格問題，是 median-of-3 能不能發揮作用的前提。實測的失效案例：
     *
     * ```text
     * cooked-assets    15.30  15.61  26.01   ← 干擾從這裡開始
     * ecs-instancing   25.80  26.51  25.91   ← 三次全在干擾期內，中位數也壞了
     * instancing       31.71  31.71  19.50   ← 干擾結束，第 3 次恢復
     * ```
     *
     * 那次外部干擾持續約兩分鐘。因為 `ecs-instancing` 的三次重複是**相鄰**的，
     * 它們全部落在干擾窗內 —— 取中位數完全沒有幫助，結果是 +76% 的假警報。
     * （`instancing` 的「恢復」排除了散熱累積：散熱只會越來越糟。）
     *
     * 交錯之後，同一段兩分鐘的干擾最多只能污染每個場景的**一次**取樣，
     * 中位數必然存活。總執行次數與頁面載入次數完全不變。
     */
    const attemptsByScene = new Map<string, BenchmarkReport[]>();
    const abandoned = new Set<string>();

    for (let pass = 0; pass < repeat; pass++) {
      if (repeat > 1) log(`\n── 第 ${pass + 1}/${repeat} 輪 ──`);
      for (const run of runs) {
        const label = run.label ?? run.id;
        // 已經失敗的場景不再重試：同樣的錯誤重複三次只是浪費時間
        if (abandoned.has(label)) continue;
        try {
          const report = await runOne(browser, baseUrl, run, timeoutMs, log);
          report.scene = label;
          const attempts = attemptsByScene.get(label) ?? [];
          attempts.push(report);
          attemptsByScene.set(label, attempts);
          // 同時印出開頭視窗：只看穩定期 p95 會漏掉啟動成本的變異，
          // 而 shader 快取造成的十倍差異就是在那裡被錯過的。
          log(
            `  ${label.padEnd(26)} p95 ${report.timing.deltaMs.p95.toFixed(2).padStart(7)}ms  ` +
              `early ${report.earlyFrames.totalMs.toFixed(0)}ms`,
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          failures.push({ scene: label, error: detail });
          abandoned.add(label);
          log(`  ✗ ${label}: ${detail}`);
        }
      }
    }

    log('');
    for (const run of runs) {
      const label = run.label ?? run.id;
      const attempts = attemptsByScene.get(label);
      if (attempts === undefined || attempts.length === 0) continue;

      const chosen = medianReport(attempts);
      if (attempts.length > 1) {
        const spread = p95Spread(attempts);
        const early = attempts.map((a) => a.earlyFrames.totalMs);
        // 把變異寫進報告。看不見的變異會被當成回歸。
        chosen.notes = [
          ...(chosen.notes ?? []),
          `${attempts.length} 次交錯執行取中位數；frame p95 範圍 ${spread.min.toFixed(2)}–${spread.max.toFixed(2)}ms（±${spread.spreadPct.toFixed(1)}%）；` +
            `開頭 30 幀 ${Math.min(...early).toFixed(0)}–${Math.max(...early).toFixed(0)}ms`,
        ];
      }
      reports.push(chosen);

      log(
        `  ✓ ${label.padEnd(26)} ${chosen.frames} 幀  frame p50 ${chosen.timing.deltaMs.p50.toFixed(2)}ms  ` +
          `p95 ${chosen.timing.deltaMs.p95.toFixed(2)}ms  ` +
          `gpu ${chosen.timing.gpuRenderMs === null ? 'n/a' : `${chosen.timing.gpuRenderMs.p50.toFixed(2)}ms`}`,
      );
    }
  } finally {
    await browser?.close();
    server?.httpServer.close();
  }

  return { reports, failures };
}

/**
 * 優先使用系統安裝的 Chrome，其次才用 Playwright 自帶的 Chromium。
 *
 * 對 GPU benchmark 來說這個順序是刻意的：系統 Chrome 用的是使用者真正的驅動與
 * GPU 設定，而 Chrome for Testing 的建置在 GPU 行為上可能不同。我們要量的是
 * 「使用者實際會遇到的效能」。實際用了哪一個由報告裡的 userAgent 記錄。
 */
async function launchBrowser(profile: RunProfile): Promise<Browser> {
  const attempts: Array<{ label: string; channel?: string }> = [
    { label: '系統 Chrome', channel: 'chrome' },
    { label: 'Playwright 內建 Chromium' },
  ];

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      return await chromium.launch({
        headless: profile.headless,
        args: profile.args,
        ...(attempt.channel !== undefined ? { channel: attempt.channel } : {}),
      });
    } catch (error) {
      errors.push(`${attempt.label}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }

  throw new Error(
    `無法啟動瀏覽器。\n    ${errors.join('\n    ')}\n` +
      `    若要使用內建 Chromium，先執行：pnpm exec playwright install chromium`,
  );
}

async function runOne(
  browser: Browser,
  baseUrl: string,
  run: SceneRun,
  timeoutMs: number,
  log: (message: string) => void,
): Promise<BenchmarkReport> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const consoleErrors: string[] = [];

  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`console: ${msg.text()}`);
  });

  try {
    const url = buildUrl(baseUrl, run);
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });

    const state = await waitForCompletion(page, timeoutMs);

    if (state.phase === 'failed' || state.report === null) {
      const reason = state.error ?? '沒有產生報告';
      throw new Error(`${reason}${consoleErrors.length > 0 ? `\n    ${consoleErrors.join('\n    ')}` : ''}`);
    }

    // 頁面錯誤不會讓量測失敗，但一定要說出來 —— 靜默的錯誤最危險
    if (consoleErrors.length > 0) {
      log(`  ! 頁面回報 ${consoleErrors.length} 則錯誤`);
      state.report.notes = [...(state.report.notes ?? []), ...consoleErrors.slice(0, 10)];
    }

    // 場景自我檢查失敗代表功能壞了，不是效能退步。這比任何數字都嚴重。
    const verdict = state.report.verdict;
    if (verdict != null && !verdict.ok) {
      throw new Error(`場景自我檢查失敗：${verdict.detail}`);
    }
    if (verdict != null) {
      log(`  · ${verdict.detail}`);
    }

    // 記憶體漂移是最便宜的洩漏偵測。門檻取得寬鬆，只抓明顯的單調成長。
    const driftMB = state.report.memory.driftBytes / (1024 * 1024);
    if (driftMB > MEMORY_DRIFT_WARN_MB) {
      const message = `GPU 記憶體在執行期間成長 ${driftMB.toFixed(1)}MB，可能有資源沒被釋放`;
      log(`  ! ${message}`);
      state.report.notes = [...(state.report.notes ?? []), message];
    }

    return state.report;
  } finally {
    await context.close();
  }
}

/**
 * 取 frame p95 的中位數那一次。
 *
 * 用中位數而不是最佳值：最佳值代表的是「理想條件下」的效能，但使用者不會
 * 永遠處於理想條件。中位數是比較有代表性、也比較穩定的一次。
 */
function medianReport(attempts: readonly BenchmarkReport[]): BenchmarkReport {
  const sorted = [...attempts].sort((a, b) => a.timing.deltaMs.p95 - b.timing.deltaMs.p95);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

function p95Spread(attempts: readonly BenchmarkReport[]): {
  min: number;
  max: number;
  spreadPct: number;
} {
  const values = attempts.map((a) => a.timing.deltaMs.p95);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { min, max, spreadPct: min > 0 ? ((max - min) / min) * 100 : 0 };
}

function buildUrl(baseUrl: string, run: SceneRun): string {
  const url = new URL(baseUrl);
  url.searchParams.set('scene', run.id);
  url.searchParams.set('autorun', '1');
  url.searchParams.set('warmup', String(run.warmup));
  url.searchParams.set('frames', String(run.frames));
  for (const [key, value] of Object.entries(run.params ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function waitForCompletion(page: Page, timeoutMs: number): Promise<HarnessStateShape> {
  const handle = await page.waitForFunction(
    () => {
      const state = (window as unknown as { __wwBenchmark?: HarnessStateShape }).__wwBenchmark;
      if (state === undefined) return null;
      return state.phase === 'done' || state.phase === 'failed' ? state : null;
    },
    undefined,
    { timeout: timeoutMs, polling: 250 },
  );
  return (await handle.jsonValue()) as HarnessStateShape;
}
