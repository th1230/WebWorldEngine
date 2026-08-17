import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

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
  if (main > MAIN_BUNDLE_BUDGET) {
    throw new Error(
      `主 script ${(main / 1024).toFixed(1)} kB 超過 ${MAIN_BUNDLE_BUDGET / 1024} kB 的預算`,
    );
  }
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
  await page.close();
}

async function serve(dir) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = join(dir, path === '/' ? 'index.html' : path);
    if (!file.startsWith(dir)) {
      res.writeHead(403).end();
      return;
    }
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
  await new Promise((resolve) => server.listen(0, resolve));
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
