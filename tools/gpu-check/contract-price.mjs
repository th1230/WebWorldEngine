import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
import { listenSafe } from '../lib/listen-safe.mjs';
import { assertDistFresh } from '../lib/dist-fresh.mjs';

/**
 * 品質契約每嚴一格，要付多少 GPU 時間。
 *
 * ## 這不是 gate，是探針
 *
 * 準則第八條要求「每一個報出來的指標都要有一條會讓它失敗的線」。這支沒有線
 * ——它回答的是「契約訂在哪裡才划算」，那是政策，不是退步。所以它不進
 * `verify:all`。
 *
 * ## 為什麼需要它
 *
 * LOD 的誤差本來是拿 meshoptimizer 的估計值，而那個值**每一階都低估**（最多
 * 1.48 倍）。改成真的量之後，遠景那組從 6.5 ms 變成 16.5 ms —— 看起來像
 * 效能退步 2.6 倍。
 *
 * 但那不是退步，是**以前沒有真的守住 2 像素**。要證明這件事就得看：把門檻
 * 放寬回去，時間是不是就回來了。實測：
 *
 * | `errorPixels` | GPU | 三角形 |
 * | ---: | ---: | ---: |
 * | 2（誠實的預設） | 16.49 ms | 2,945,638 |
 * | 3 | 10.51 ms | 1,516,722 |
 * | 4 | 7.91 ms | 1,006,722 |
 *
 * 而修正前的行為是 6.5 ms / 728,570 個三角形 —— 落在 4 以外。也就是那時候
 * 宣稱 2 像素、實際交付大約 4 到 5 像素。
 *
 * ## 這張表真正的用途
 *
 * 它讓「契約多嚴」從一句話變成一個標價。開發者要更快就把 `errorPixels` 調大，
 * 而他知道自己買到什麼、付了什麼 —— 那正是四問第一問：**會改變畫面的決定
 * 是開發者的**，引擎負責把價錢算出來交出去。
 */
const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// 關卡吃的是建好的產物 —— 它比原始碼舊的話，這一輪的每個數字都沒有意義。
assertDistFresh(root);
const COOKED = join(root, 'apps/benchmark/public');
const DIST = join(root, 'apps/example/dist');
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const file = path.startsWith('/cooked')
    ? join(COOKED, path)
    : join(DIST, path === '/' ? 'index.html' : path);
  readFile(file).then(
    (b) => {
      res.writeHead(200, {
        'content-type':
          { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }[
            extname(file)
          ] ?? 'application/octet-stream',
      });
      res.end(b);
    },
    () => res.writeHead(404).end(),
  );
});
await listenSafe(server);
const url = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ channel: 'chrome' });
const BASE = '?cooked=1&count=20000&hlodBudgetMB=512';
const CASES = [
  ['2（預設）', ''],
  ['3', '&errorPixels=3'],
  ['4', '&errorPixels=4'],
];
const rows = [];
for (let round = 0; round < 3; round++) {
  const row = {};
  for (const [key, q] of CASES) {
    const page = await browser.newPage();
    await page.goto(url + BASE + q, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ww?.totalFrames > 90, undefined, { timeout: 60000 });
    row[key] = await page.evaluate(() => {
      const w = window.__ww;
      w.settleHlod(6.0);
      w.renderer.info.reset();
      w.step(6.0);
      const tri = w.renderer.info.render.triangles;
      return w.measureGpuMs(6.0).then((g) => ({ ms: g.p50, tri }));
    });
    await page.close();
  }
  rows.push(row);
  console.log(
    `  第 ${round + 1} 輪  ` + CASES.map(([k]) => `${k} ${row[k].ms.toFixed(2)}`).join('   '),
  );
}
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log('');
for (const [k] of CASES) {
  console.log(
    `  errorPixels ${k.padEnd(10)} ${med(rows.map((r) => r[k].ms)).toFixed(3)} ms   ${rows[0][k].tri.toLocaleString('en-US').padStart(11)} 個三角形`,
  );
}
await browser.close();
server.close();
