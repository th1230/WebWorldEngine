import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
import { listenSafe } from '../lib/listen-safe.mjs';

/**
 * 網站的指標（W5）。
 *
 * ## 為什麼幀率不是這裡的重點
 *
 * benchmark 量的是「跑起來之後多快」。網站在意的是另外四件事，而它們
 * **一個都不會出現在幀率裡**：
 *
 * 1. **首次可見時間** —— 使用者盯著白畫面多久
 * 2. **下載總量** —— 手機網路上那是好幾秒
 * 3. **分頁記憶體** —— 超過就被瀏覽器殺掉，而不是變慢
 * 4. **與頁面其他內容共存** —— 3D 通常只是頁面的一塊，不是整個頁面
 *
 * 第四項尤其容易被忽略：demo 都是整頁一個 canvas 加自己的 rAF 迴圈，
 * 那種寫法在真實網站上會跟頁面本身的動畫、捲動、其他元件打架。
 *
 * ## 這裡量的是 example app
 *
 * 它是**一個普通的 Three.js 專案**，不是 benchmark 場景。網站的指標必須
 * 用網站的形狀量 —— benchmark app 為了量測本身載入了 overlay、harness、
 * 十幾個場景，那些數字對使用者沒有意義。
 */

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const APP = join(root, 'apps/example');
const DIST = join(APP, 'dist');

/** 首次可見時間的上限，毫秒。 */
const FIRST_FRAME_BUDGET_MS = 3000;

/** 主套件（不含延遲抓取的 chunk）的下載上限，位元組。 */
const MAIN_BUNDLE_BUDGET = 800 * 1024;

/**
 * 下載總量的上限，位元組。
 *
 * 主 script 早就有線了，總量卻只是印出來 —— 而會出事的正是總量：不小心
 * 把某個相依項打包進去、或多切出一個永遠會被抓的 chunk，主 script 可能
 * 沒變。
 */
const TOTAL_DOWNLOAD_BUDGET = 1024 * 1024;

/**
 * GPU 物件數的上限（幾何 + 貼圖）。
 *
 * 這一項原本也只是印出來。而這一輪抓到的其中一個 bug 正是這個形狀：
 * 遠景合併的槽位池每次重建都重配，GPU 記憶體三秒漲 90 MB —— 幾何數
 * 一路往上，而三個檢查全綠。
 *
 * example 穩態是 3 個幾何、3 張貼圖，所以 32 是「明顯在漏」的等級，
 * 不是一條卡住現況的線。
 */
const GPU_OBJECT_BUDGET = 32;

/**
 * JS heap 的上限，MB。
 *
 * ## 為什麼非要有這一條
 *
 * 這個數字原本只被印出來，沒有人擋它。於是遠景合併的記憶體預算從
 * 「要多少給多少」改過去之後，heap 從 165 MB 漲到 **1,005 MB** ——
 * 三個檢查全綠，因為沒有一個在看它。
 *
 * 網站上的 3D 通常只是頁面的一塊，而手機的分頁記憶體上限是幾百 MB。
 * 一個 demo 用掉 1 GB 代表它在真實裝置上會被作業系統殺掉。
 *
 * 150 是一個網站預算，不是引擎常數（引擎的上限是 `hlodBudgetMB`，
 * 由開發者決定）。它的工作只有一件：讓上面那種退步當場失敗。
 */
const HEAP_BUDGET_MB = 150;

async function main() {
  console.log('建置 example app…');
  execFileSync('pnpm', ['--filter', './apps/example', 'build'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  });

  const server = await serve(DIST);
  const browser = await launch();
  try {
    await measureLoad(browser, server.url);
    await measureCoexistence(browser, server.url);
  } finally {
    await browser.close();
    server.close();
  }
}

/**
 * 首次可見、下載量、記憶體。
 *
 * 三個一起量是刻意的：它們互相牽制。把 LOD 產生搬到 worker 會讓首次可見
 * 變快但下載量變大；把資產 cook 好會讓下載量變大但首次可見變快。
 * 分開量會讓人只優化其中一個。
 */
async function measureLoad(browser, url) {
  const page = await browser.newPage();
  const transfers = new Map();
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    void response
      .body()
      .then((body) => transfers.set(path, body.byteLength))
      .catch(() => undefined);
  });

  const problems = [];
  page.on('pageerror', (e) => problems.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });

  await page.goto(url, { waitUntil: 'networkidle' });

  const result = await page
    .waitForFunction(() => window.__ww?.firstFrameMs ?? null, null, { timeout: 30_000 })
    .then((h) => h.jsonValue());

  if (problems.length > 0) {
    throw new Error(`載入時有錯誤：\n  ${problems.join('\n  ')}`);
  }

  // 讓 LOD 產生與資產載入都完成，再量記憶體 —— 只量載入當下會漏掉
  // 「跑起來之後才配置的東西」，而分頁是被那個殺掉的。
  await page.waitForTimeout(2000);
  const memory = await page.evaluate(() => {
    const info = window.__ww.renderer.info;
    return {
      heapMB: (performance.memory?.usedJSHeapSize ?? 0) / 1048576,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    };
  });

  const scripts = [...transfers.entries()].filter(([p]) => p.endsWith('.js'));
  const total = [...transfers.values()].reduce((sum, n) => sum + n, 0);
  const main = scripts.reduce((max, [, n]) => Math.max(max, n), 0);

  console.log('\n── 網站指標 ──');
  console.log(`首次可見        ${result.toFixed(0)} ms`);
  console.log(`下載總量        ${(total / 1024).toFixed(1)} kB（${transfers.size} 個檔案）`);
  console.log(`  最大的 script ${(main / 1024).toFixed(1)} kB`);
  console.log(`JS heap         ${memory.heapMB.toFixed(1)} MB`);
  console.log(`GPU 物件        ${memory.geometries} 個幾何、${memory.textures} 張貼圖`);

  if (result > FIRST_FRAME_BUDGET_MS) {
    throw new Error(`首次可見 ${result.toFixed(0)} ms 超過 ${FIRST_FRAME_BUDGET_MS} ms 的預算`);
  }
  if (total > TOTAL_DOWNLOAD_BUDGET) {
    throw new Error(
      `下載總量 ${(total / 1024).toFixed(1)} kB 超過 ${TOTAL_DOWNLOAD_BUDGET / 1024} kB 的預算`,
    );
  }
  const gpuObjects = memory.geometries + memory.textures;
  if (gpuObjects > GPU_OBJECT_BUDGET) {
    throw new Error(
      `GPU 物件 ${gpuObjects} 個超過 ${GPU_OBJECT_BUDGET} —— 最可能是有東西沒被釋放`,
    );
  }
  if (main > MAIN_BUNDLE_BUDGET) {
    throw new Error(
      `主 script ${(main / 1024).toFixed(1)} kB 超過 ${MAIN_BUNDLE_BUDGET / 1024} kB 的預算`,
    );
  }
  // performance.memory 只有 Chromium 有。拿不到時是 0 —— 那時不擋，
  // 但也不能假裝檢查過了。
  if (memory.heapMB > HEAP_BUDGET_MB) {
    throw new Error(
      `JS heap ${memory.heapMB.toFixed(1)} MB 超過 ${HEAP_BUDGET_MB} MB 的預算。` +
        '最可能的來源是遠景合併的槽位池（hlodBudgetMB）。',
    );
  }
  if (memory.heapMB === 0) console.log('  （這個瀏覽器沒有 performance.memory，heap 沒有被檢查）');
  await page.close();
}

/**
 * 與頁面其他內容共存。
 *
 * ## 這一項驗什麼
 *
 * 3D 在真實網站上通常只是頁面的**一塊**：一個 400×300 的區塊，旁邊有文字、
 * 表單、其他動畫，而且頁面自己有 rAF 迴圈在跑。
 *
 * 套件若假設「畫布就是整個視窗」或「rAF 是我的」，在那種頁面上會壞 ——
 * 而 demo 永遠看不出來，因為 demo 就是整頁一個 canvas。
 *
 * ## 怎麼驗
 *
 * 把 example app 放進一個 iframe（就是頁面裡的一塊），外層頁面跑自己的
 * rAF 動畫，然後檢查兩件事：外層的動畫有沒有繼續跑，以及 3D 有沒有畫出來。
 */
async function measureCoexistence(browser, url) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><meta charset="utf-8">
<h1>一個普通的頁面</h1>
<p>3D 只是其中一塊。</p>
<div id="beat">0</div>
<iframe id="viewport" src="${url}" style="width:400px;height:300px;border:1px solid #888"></iframe>
<p>下面還有別的內容。</p>
<script>
  // 頁面自己的動畫迴圈。套件若獨佔 rAF，這個數字會停住。
  let beats = 0;
  const tick = () => { beats++; document.getElementById('beat').textContent = beats; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__beats = () => beats;
</script>`);

  await page.waitForTimeout(3000);

  const frame = page.frames().find((f) => f.url().startsWith(url));
  if (frame === undefined) throw new Error('iframe 沒有載入');

  const inner = await frame.evaluate(() => {
    const ww = window.__ww;
    const canvas = document.querySelector('canvas');
    return {
      firstFrameMs: ww?.firstFrameMs ?? null,
      visible: ww?.rocks?.stats?.visible ?? null,
      canvasWidth: canvas?.width ?? 0,
      // 畫布若比視窗大，就是套件（或 app）假設了自己佔滿整個視窗。
      windowWidth: window.innerWidth,
    };
  });
  const beats = await page.evaluate(() => window.__beats());

  console.log('\n── 與頁面共存 ──');
  console.log(`外層頁面的 rAF  ${beats} 幀（3 秒內）`);
  console.log(`iframe 首次可見 ${inner.firstFrameMs?.toFixed(0) ?? 'null'} ms`);
  console.log(`iframe 可見物件 ${inner.visible}`);
  console.log(`畫布 ${inner.canvasWidth} px / 視窗 ${inner.windowWidth} px`);

  // 外層完全停住代表 3D 那一塊把主執行緒吃光了。
  if (beats < 30) throw new Error(`外層頁面只跑了 ${beats} 幀 —— 主執行緒被佔住了`);
  if (inner.firstFrameMs === null) throw new Error('iframe 裡沒有畫出任何一幀');
  if (!(inner.visible > 0)) throw new Error(`iframe 裡可見物件是 ${inner.visible}`);
  if (inner.canvasWidth > inner.windowWidth) {
    throw new Error(`畫布 ${inner.canvasWidth} px 比視窗還寬 —— 假設了獨佔整個視窗`);
  }

  await measureIdleWhenHidden(page, frame);
  await page.close();
}

/**
 * 那一塊捲出畫面之後，套件要**完全停下來**。
 *
 * ## 為什麼這是網站條件而不是效能條件
 *
 * 網站上的 3D 大多數時間不在視野裡（在頁面下方、在別的分頁）。套件若自己
 * 排了 `setInterval` 或 `requestIdleCallback` 去串流、去烘遠景，那些工作
 * 會在使用者根本沒在看的時候吃他的電池與主執行緒。
 *
 * demo 永遠看不出來 —— demo 就是整頁一個 canvas，永遠在視野裡。
 *
 * ## 怎麼驗
 *
 * 把 iframe 設成 `display:none`（瀏覽器會停掉它的 rAF），然後看引擎的
 * 幀數有沒有繼續往前。**驗的是行為不是實作** —— 抓 `setInterval` 的字串
 * 擋不住第三種寫法。
 */
async function measureIdleWhenHidden(page, frame) {
  const before = await frame.evaluate(() => window.__ww?.totalFrames ?? null);
  if (before === null) throw new Error('iframe 沒有回報幀數');

  await page.evaluate(() => {
    document.getElementById('viewport').style.display = 'none';
  });
  await page.waitForTimeout(1500);
  const after = await frame.evaluate(() => window.__ww?.totalFrames ?? null);

  console.log(`捲出畫面後      ${after - before} 幀（1.5 秒內）`);
  // 0 是預期值。留一點餘裕給「隱藏的那一刻正好有一幀在飛」。
  if (after - before > 2) {
    throw new Error(
      `那一塊看不見了卻還畫了 ${after - before} 幀 —— 套件自己排了工作，` +
        '使用者沒在看的時候還在吃電池',
    );
  }
}

async function serve(dir) {
  // `/cooked*` 從 benchmark 的 public 讀 —— 那是 `pnpm cook` 的輸出，不進版控，
  // 而 example 的 vite 設定只在 dev server 上代理它。建置後的 app 少了這一段
  // 就載不到貼圖，於是 `?cooked=1` 會靜靜退回純色材質 —— **檢查照樣全綠，
  // 只是它驗的內容裡根本沒有貼圖**。
  const COOKED = join(root, 'apps/benchmark/public');
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = path.startsWith('/cooked')
      ? join(COOKED, path)
      : join(dir, path === '/' ? 'index.html' : path);
    readFile(file).then(
      (bytes) => {
        const type =
          { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }[
            extname(file)
          ] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type });
        res.end(bytes);
      },
      () => res.writeHead(404).end(),
    );
  });
  await listenSafe(server);
  return { url: `http://localhost:${server.address().port}/`, close: () => server.close() };
}

async function launch() {
  const errors = [];
  for (const channel of ['chrome', undefined]) {
    try {
      // 有頭：無頭沒有真的 GPU，而首次可見時間裡有一大段是建立 GL context
      // 與編譯 shader —— 那是網站上真實存在的成本。
      return await chromium.launch(channel === undefined ? {} : { channel });
    } catch (error) {
      errors.push(String(error).split('\n')[0]);
    }
  }
  throw new Error(`無法啟動瀏覽器：\n  ${errors.join('\n  ')}`);
}

await main();
