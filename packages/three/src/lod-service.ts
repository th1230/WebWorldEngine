import type {
  GeneratedLevel,
  GeometryData,
  LodGenerationOptions,
} from './lod-generation.ts';
import type { LodRequest, LodResponse } from './lod-worker.ts';

/**
 * 主執行緒這一側：把 LOD 產生丟給 worker。
 *
 * ## 為什麼一定要離開主執行緒
 *
 * 簡化一個中等網格是幾十到幾百毫秒。在主執行緒上做，畫面就是卡住那麼久
 * —— 而卡住的時機正是**使用者剛打開頁面**的時候。網站上那一下比穩定期的
 * 幀率重要得多。
 *
 * ## 為什麼是一個共用的 worker 而不是每個物件一個
 *
 * LOD 產生是**開場一陣子**的工作：場景建好時一次湧入幾十個請求，之後幾乎
 * 不再發生。每個物件開一個 worker 等於同時開幾十個執行緒去搶同一批核心，
 * 而每個 worker 都要各自載入一份 WASM。
 *
 * 一個 worker 依序處理就夠了 —— 它們本來就在等同一顆 CPU。真的需要平行化
 * 時再量了再說（這條路上還沒有任何數字）。
 */

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (response: LodResponse) => void>();

/** Worker 不可用時（測試環境、舊瀏覽器、CSP 擋掉 blob:）退回主執行緒。 */
let workerUsable = true;

/** 同時來的請求共用同一次啟動，不會各自開一個 worker。 */
let starting: Promise<Worker | null> | null = null;

/**
 * 等 worker 報到多久才放棄。
 *
 * 這個值只在**壞掉的時候**看得到：worker 正常時報到是毫秒級的。設得長一點
 * 沒有代價（正常路徑不會等到），設得短則會在慢機器上誤判成壞掉，然後把
 * 幾百毫秒的簡化搬到主執行緒 —— 那是使用者剛打開頁面的時候。
 */
const READY_TIMEOUT_MS = 3000;

/**
 * 建立 worker。
 *
 * ## 為什麼是動態 import 一個內嵌的 worker
 *
 * 常見的寫法是 `new Worker(new URL('./lod-worker.js', import.meta.url))`。
 * 那對**應用程式**是對的，對**發布出去的套件**是錯的：
 *
 * - 打包工具各自對那個模式有不同處理（Vite 與 webpack 認得它、esbuild 不認）
 * - 認得的那些會把 worker 檔案搬到使用者的輸出目錄；不認得的不會，
 *   於是那個 URL 指向 `node_modules` 裡一個不會被部署的檔案
 * - 而失敗的樣子是 404 之後**靜靜退回主執行緒** —— 畫面正常，只是開場卡頓
 *
 * `?worker&inline` 把 worker 的原始碼內嵌成 blob，**完全沒有路徑要解析**。
 * 動態 `import()` 讓它留在自己的 chunk 裡，所以自備 LOD 鏈的專案不會下載它。
 *
 * 代價是需要 CSP 允許 `worker-src blob:`。不允許的話會走下面的退路，
 * 並且說出來。
 */
function ensureWorker(): Promise<Worker | null> {
  if (!workerUsable) return Promise.resolve(null);
  if (worker !== null) return Promise.resolve(worker);
  starting ??= startWorker();
  return starting;
}

/**
 * 啟動 worker，並且**等它報到**才算數。
 *
 * ## 為什麼不能建構完就直接用
 *
 * `new Worker(…)` 是同步成功、非同步失敗的：URL 是 404、CSP 擋掉 blob:，
 * 建構那一行照樣過，錯誤要等到下一個 tick 才來。中間這段時間裡，第一個
 * 請求已經把幾何 `postMessage` 出去了 —— 而那是**轉移**，緩衝區當場被
 * 抽離主執行緒。等錯誤傳回來，資料已經不在了，連退回主執行緒重算都做
 * 不到，那個 mesh 就永久停在最細的幾何。
 *
 * 先握手就沒有這個縫：資料只會交給一個已經證明活著的 worker。
 */
async function startWorker(): Promise<Worker | null> {
  try {
    const { default: LodWorker } = await import('./lod-worker.ts?worker&inline');
    const created = new LodWorker();

    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
      const settle = (ok: boolean) => {
        clearTimeout(timer);
        created.removeEventListener('message', onMessage);
        created.removeEventListener('error', onError);
        resolve(ok);
      };
      const onMessage = () => settle(true);
      const onError = () => settle(false);
      created.addEventListener('message', onMessage, { once: true });
      created.addEventListener('error', onError, { once: true });
    });

    if (!ready) {
      created.terminate();
      console.warn(
        'WW: LOD worker 起不來，改在主執行緒產生（會造成一次卡頓）。' +
          ' 常見原因是 CSP 沒有允許 worker-src blob:。',
      );
      workerUsable = false;
      return null;
    }

    worker = created;
    worker.addEventListener('message', (event: MessageEvent<LodResponse>) => {
      const resolve = pending.get(event.data.id);
      if (resolve === undefined) return;
      pending.delete(event.data.id);
      resolve(event.data);
    });
    worker.addEventListener('error', (event) => {
      // 走到這裡代表 worker 是**報到之後才死的** —— 載入失敗在上面的握手
      // 就攔掉了。這一種很罕見（記憶體不足、瀏覽器回收），而且沒有乾淨的
      // 退路：請求用的緩衝區已經轉移出去了，主執行緒手上沒有資料可以重算。
      //
      // 所以這裡只能把等待中的請求全部收掉。不收的話呼叫端會永遠停在
      // 「產生中」，而且看起來只是比較慢。
      const why = event.message !== '' && event.message !== undefined
        ? event.message
        : '沒有錯誤訊息';
      console.error('WW: LOD worker 中途失效，之後改在主執行緒產生。', why);
      workerUsable = false;
      worker = null;
      starting = null;
      for (const [id, resolve] of pending) {
        resolve({ id, ok: false, error: `worker 中途失效：${why}` });
      }
      pending.clear();
    });
    return worker;
  } catch (error) {
    console.warn(
      'WW: 無法載入 LOD worker，改在主執行緒產生（會造成一次卡頓）。',
      error instanceof Error ? error.message : error,
    );
    workerUsable = false;
    return null;
  }
}

/**
 * 產生 LOD 各階。回傳的**不含第 0 階**。
 *
 * worker 不可用時會退回主執行緒 —— 並且**說出來**。靜默地在主執行緒上跑
 * 會變成一個沒人知道來源的開場卡頓。
 */
export interface LodTiming {
  levels: GeneratedLevel[];
  /** 簡化本身花掉的時間。在 worker 裡就是 worker 的時間，退路則是主執行緒的。 */
  elapsedMs: number;
  offMainThread: boolean;
}

export async function requestLodLevels(
  source: GeometryData,
  options: LodGenerationOptions = {},
): Promise<LodTiming> {
  const target = await ensureWorker();
  if (target === null) {
    // **動態 import。** 靜態 import 會把 meshoptimizer（含 WASM）拉進主
    // 套件，於是**每一個使用者都要下載它**，包括自備 LOD 鏈、根本不會走到
    // 這條路的人。那正好違反「用了更好，不用也能動」在下載量上的意思。
    //
    // 實測（apps/example，把這一行換成靜態 import 對照）：主套件
    // 644.8 → **608.7 kB**。meshoptimizer 落在兩個延遲抓取的 chunk 裡：
    // `lod-worker` 44.9 kB（正常路徑）與 `lod-generation` 44.0 kB（這條
    // 退路），兩個都只有真的用到才會下載。
    const { generateLodLevels } = await import('./lod-generation.ts');
    const started = performance.now();
    const levels = await generateLodLevels(source, options);
    return { levels, elapsedMs: performance.now() - started, offMainThread: false };
  }

  const id = nextId++;
  const request: LodRequest = { id, source, options };

  const response = await new Promise<LodResponse>((resolve) => {
    pending.set(id, resolve);
    // 這些緩衝區是主執行緒為了這次請求複製出來的（見 InstancedMesh），
    // 所以轉移是安全的 —— 使用者的 BufferGeometry 不會被抽走。
    target.postMessage(request, transferablesOfRequest(source));
  });

  if (!response.ok) {
    throw new Error(response.error);
  }
  return { levels: response.levels, elapsedMs: response.elapsedMs, offMainThread: true };
}

function transferablesOfRequest(source: GeometryData): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  if (source.indices !== null) buffers.push(source.indices.buffer as ArrayBuffer);
  for (const attribute of Object.values(source.attributes)) {
    buffers.push(attribute.array.buffer as ArrayBuffer);
  }
  return buffers;
}

/** 測試用：把服務歸零。正常執行不需要 —— worker 的生命週期跟著分頁。 */
export function resetLodService(): void {
  worker?.terminate();
  worker = null;
  starting = null;
  workerUsable = true;
  pending.clear();
}
