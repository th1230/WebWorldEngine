import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

/**
 * 旋鈕到底有沒有省到 GPU —— **量它，而且擋它**。
 *
 * ## 為什麼要有這個檢查
 *
 * 這個套件所有的證據都在 CPU 那一側：幀時間、分組時間、traversal 時間。但
 * 這裡做的每一件事 —— 選階、剔除、遠景合併 —— **改變的是送給 GPU 的東西**。
 * 一個把 CPU 省下來卻讓 GPU 變貴的改動，在現有的量測下全部是綠的。
 *
 * 這個檢查補的就是那一側：同一份內容、同一條相機路徑，只換 `?ww=0/1`，
 * 比真正的 GPU 時間。
 *
 * ## 它已經擋下過什麼
 *
 * `materialDetailUvPerPixel`（貼圖被縮小時跳過 normal/ORM 的取樣）。整套做完、
 * 畫質在契約內、單元測試綠的 —— 接上 GPU 計時之後是**淨虧 15–20%**：逐
 * fragment 的動態分支要 16%，而省下來的是「已經在快取裡的小 mip」。前提反了，
 * 而在這個檢查存在之前沒有任何東西看得出來。
 *
 * ## 為什麼不是 pnpm bench
 *
 * `pnpm bench` 的 GPU 計時跑在 benchmark app 上，走 **WebGPU**。example 這條路
 * 走 **WebGL**，而兩邊的驅動、shader、上傳路徑都不一樣。兩邊都要量。
 *
 * ## 為什麼不能用 performance.now
 *
 * GPU 是非同步的：`render()` 送完命令就回來了。實測開關兩邊的 CPU 時間都是
 * 0.13 ms —— 對兩邊都成立，也對兩邊都無關。
 * `EXT_disjoint_timer_query_webgl2` 是直接問 GPU 的。
 *
 * ## 為什麼 A/B 要交錯
 *
 * 這台機器的量測是雙峰的：同一個設定連續跑會整段落在其中一峰。先跑完 A 再
 * 跑完 B 很可能落在不同峰上，而那個差會被讀成「旋鈕的效果」。交錯之後逐輪
 * 配對，峰的漂移在同一輪內對兩個數字影響一樣，相除就消掉了。
 *
 * 這件事有一次實測的證據，而且是意外拿到的：兩個量測程序不小心同時在跑，
 * 遠景那組的原生絕對值在 207 / 211 / 383 / 370 ms 之間亂跳（將近兩倍），
 * 而**比值穩在 96.9%**。交錯讓兩邊在同一輪內吃到同一份干擾，相除就消掉了。
 *
 * 所以判定用的是比值，不是絕對值 —— 絕對值只拿來看合不合理。
 *
 * ## 為什麼兩種內容都要量
 *
 * 遠景那組的省法是**少畫**（剔除、合併、粗階）；近景那組沒得少畫，省的是
 * 別的。只量一種的話，量到的是那一種內容的結論，不是這個引擎的結論。
 */

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = join(root, 'apps/example/dist');

/**
 * 兩種內容，而且**必須兩種都量**，各自的門檻寫在自己旁邊。
 *
 * 遠景那組省的是「少畫」（剔除、合併、粗階），近景那組六百個大物件本來就
 * 都要畫，能省的只有選階。兩者的量級差一個數量級 —— 用同一條線的話，寬到
 * 近景過得了的那條線，遠景整個壞掉也照樣綠。
 */
const SCENES = [
  {
    name: '近景（六百個大物件，沒得少畫）',
    base: '?cooked=1&count=600&size=20&spread=400&orbit=90&hlodBudgetMB=512',
    minSaving: 0.05,
  },
  {
    name: '遠景（兩萬個，剔除與合併都有得做）',
    base: '?cooked=1&count=20000&hlodBudgetMB=512',
    minSaving: 0.5,
  },
];

const CASES = [
  { key: 'native', label: '原生 THREE.InstancedMesh', q: '&ww=0' },
  { key: 'ww', label: 'WW.InstancedMesh', q: '' },
];

const ROUNDS = 5;

async function main() {
  console.log('建置 example…');
  execFileSync('pnpm', ['--filter', '@ww/example-app', 'build'], {
    cwd: root,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  const site = await serve(DIST);
  const browser = await launch();
  const results = [];

  try {
    for (const scene of SCENES) {
      console.log(`\n${scene.name}`);
      const rounds = [];
      for (let round = 0; round < ROUNDS; round++) {
        const row = {};
        for (const c of CASES) {
          row[c.key] = await measure(browser, site.url + scene.base + c.q);
        }
        rounds.push(row);
        console.log(
          `  第 ${round + 1} 輪  ` + CASES.map((c) => `${c.key} ${fmt(row[c.key])}`).join('   '),
        );
      }
      results.push({ scene, rounds });
    }
  } finally {
    await browser.close();
    site.close();
  }

  let failed = false;
  console.log('');
  for (const { scene, rounds } of results) {
    const usable = rounds.filter((r) => CASES.every((c) => typeof r[c.key]?.ms === 'number'));
    if (usable.length === 0) {
      // 一顆計時都沒回來不是「通過」—— 沒量到就是沒量到。
      console.error(`FAIL: ${scene.name} 一輪都沒量到（沒有 EXT_disjoint_timer_query_webgl2？）`);
      console.error(JSON.stringify(rounds, null, 2));
      process.exitCode = 1;
      return;
    }
    // 逐輪配對再取中位數 —— 先各自取中位數再相除的話，峰的漂移不會抵消。
    const saving = median(usable.map((r) => 1 - r.ww.ms / r.native.ms));

    console.log(scene.name);
    for (const c of CASES) {
      const row = usable[0][c.key];
      console.log(
        `  ${c.label.padEnd(26)} ${median(usable.map((r) => r[c.key].ms)).toFixed(3)} ms` +
          `   ${row.triangles.toLocaleString('en-US').padStart(11)} 個三角形，${row.calls} 次繪製`,
      );
    }
    // ## 三角形數要跟時間一起報
    //
    // 對照組一度是用**程序化**的幾何建的，而 `?cooked=1` 時強化版吃的是
    // cook 過的鏈 —— 兩邊畫的是不同的模型（300,002 vs 2,188,802 個三角形），
    // 而那被讀成「強化版慢了兩倍」。時間單獨看的話那個結論完全成立。
    const ok = saving >= scene.minSaving;
    console.log(
      `  GPU 時間省下                ${pct(saving)}` +
        `   （這個內容的線：${pct(scene.minSaving)}）${ok ? '' : '   ← 沒過'}`,
    );
    console.log('');
    if (!ok) failed = true;
  }

  if (failed) {
    console.error(
      'FAIL: 有內容的 GPU 時間沒省到該省的。\n' +
        '這一側量的是「送給 GPU 的東西」—— CPU 那邊的檢查全綠也擋不住這一類。',
    );
    process.exitCode = 1;
    return;
  }
  console.log('OK: 兩種內容的 GPU 時間都比原生低');
}

async function measure(browser, url) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'load' });
    // 等 LOD 烘完、貼圖載完 —— 沒等的話量到的是「還在建東西」的那幾幀。
    await page.waitForFunction(() => window.__ww?.totalFrames > 90, undefined, { timeout: 60_000 });
    const result = await page.evaluate(() => {
      const w = window.__ww;
      w.renderer.info.reset();
      w.step(6.0);
      const { calls, triangles } = w.renderer.info.render;
      return w.measureGpuMs(6.0).then((gpu) => ({ gpu, calls, triangles }));
    });
    return typeof result?.gpu?.p50 === 'number'
      ? { ms: result.gpu.p50, calls: result.calls, triangles: result.triangles }
      : result;
  } finally {
    await page.close();
  }
}

const fmt = (v) => (typeof v?.ms === 'number' ? v.ms.toFixed(3) : JSON.stringify(v));
const pct = (v) => `${v >= 0 ? '' : ''}${(v * 100).toFixed(1)}%`;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function serve(dir) {
  // `/cooked*` 從 benchmark 的 public 讀 —— 少了這一段 `?cooked=1` 會靜靜退回
  // 純色材質，於是這個檢查驗的內容裡根本沒有貼圖，然後永遠量不到差別。
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
  await new Promise((resolve) => server.listen(0, resolve));
  return { url: `http://localhost:${server.address().port}/`, close: () => server.close() };
}

async function launch() {
  const errors = [];
  for (const channel of ['chrome', undefined]) {
    try {
      // 有頭：無頭沒有真的 GPU，而這裡量的是真的 GPU 時間。
      return await chromium.launch(channel === undefined ? {} : { channel });
    } catch (error) {
      errors.push(String(error).split('\n')[0]);
    }
  }
  throw new Error(`無法啟動瀏覽器：\n  ${errors.join('\n  ')}`);
}

await main();
