/**
 * 串流尖峰那 20–30 毫秒，到底是誰在跑。
 *
 * ## 為什麼要用 trace
 *
 * 前面幾輪把候選一個一個排除掉了：不是產生內容、不是引擎的任何分項、不是
 * 畫得比較多、不是改寫矩陣緩衝、也不是走 `writeMatrices` 那條路。而時間確實
 * 花在 rAF 回呼**之外**。
 *
 * 中間有一個推論是錯的，要更正：先前拿「long task 0 次」當成「沒有東西佔住
 * 主執行緒」。但 Long Task API 的門檻是 **50 ms**，而這裡的空隙是 20–30 ms
 * ——它們本來就不會被回報。那條證據什麼都沒排除。
 *
 * 所以改用 CDP 的 tracing：它記錄每一個任務，不管長短，而且帶名字。這就是
 * 先前說「要 GPU trace 才能確定」的那件事 —— 渲染程序這一側的 trace，
 * Playwright 直接給得出來。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
import { listenSafe } from '../lib/listen-safe.mjs';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = join(root, 'apps/example/dist');
const COOKED = join(root, 'apps/benchmark/public');
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (path === '/favicon.ico') { res.writeHead(204).end(); return; }
  const file = path.startsWith('/cooked') ? join(COOKED, path) : join(DIST, path === '/' ? 'index.html' : path);
  readFile(file).then(
    (b) => { res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' }[extname(file)] ?? 'application/octet-stream' }); res.end(b); },
    () => res.writeHead(404).end(),
  );
});
await listenSafe(server);

console.log('串流尖峰那 20–30 ms 是誰在跑\n');
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const base = `http://localhost:${server.address().port}`;

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultNavigationTimeout(240000);
  // 每秒 600 單位 —— 前面量到那一檔有 344/599 幀在載入。
  await page.goto(`${base}/?stream=1&count=200000&orbit=5000`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ww?.totalFrames > 120, undefined, { timeout: 240000 });

  const client = await page.context().newCDPSession(page);
  const events = [];
  client.on('Tracing.dataCollected', ({ value }) => events.push(...value));

  await client.send('Tracing.start', {
    traceConfig: {
      recordMode: 'recordAsMuchAsPossible',
      includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'],
    },
  });
  await page.evaluate(() => new Promise((resolve) => {
    let n = 0;
    const tick = () => (++n < 300 ? requestAnimationFrame(tick) : resolve());
    requestAnimationFrame(tick);
  }));
  const done = new Promise((resolve) => client.once('Tracing.tracingComplete', resolve));
  await client.send('Tracing.end');
  await done;
  await page.close();

  // 完整事件（有 dur 的）才是花時間的那些。
  const complete = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number');
  console.log(`  trace 收到 ${events.length} 筆事件，其中 ${complete.length} 筆帶時間\n`);

  // 頂層任務：RunTask。它們之間的空隙就是我們看到的那一段。
  const tasks = complete.filter((e) => e.name === 'RunTask').sort((a, b) => a.ts - b.ts);
  if (tasks.length === 0) throw new Error('trace 裡沒有 RunTask —— 類別可能不對');

  const durations = tasks.map((t) => t.dur / 1000).sort((a, b) => a - b);
  const q = (f) => durations[Math.min(durations.length - 1, Math.floor(durations.length * f))];
  console.log(`  主執行緒任務 ${tasks.length} 個：p50 ${q(0.5).toFixed(2)} ms，p95 ${q(0.95).toFixed(2)} ms，最長 ${durations[durations.length - 1].toFixed(2)} ms`);

  // 貴的任務裡面，時間花在哪個子事件上。
  const heavy = tasks.filter((t) => t.dur / 1000 >= 10);
  console.log(`  超過 10 ms 的任務：${heavy.length} 個\n`);

  const attribute = (task) => {
    const inside = complete.filter(
      (e) => e.ts >= task.ts && e.ts + e.dur <= task.ts + task.dur && e !== task && e.name !== 'RunTask',
    );
    // 只取最上層的那些（不被其他被選中的事件包住）。
    const top = inside.filter((e) => !inside.some((o) => o !== e && o.ts <= e.ts && o.ts + o.dur >= e.ts + e.dur));
    const byName = new Map();
    for (const e of top) byName.set(e.name, (byName.get(e.name) ?? 0) + e.dur / 1000);
    return byName;
  };

  const totals = new Map();
  for (const task of heavy) {
    for (const [name, ms] of attribute(task)) totals.set(name, (totals.get(name) ?? 0) + ms);
  }
  const heavyTotal = heavy.reduce((a, b) => a + b.dur / 1000, 0);
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  console.log(`  那 ${heavy.length} 個貴任務一共 ${heavyTotal.toFixed(0)} ms，裡面是：`);
  for (const [name, ms] of ranked) {
    console.log(`    ${name.padEnd(34)} ${ms.toFixed(1)} ms（${((ms / heavyTotal) * 100).toFixed(0)}%）`);
  }
  const explained = ranked.reduce((a, b) => a + b[1], 0);
  console.log(`\n  以上解釋了 ${((explained / heavyTotal) * 100).toFixed(0)}%`);
  // ## 再往裡面一層：rAF 回呼裡面是什麼
  //
  // 「FireAnimationFrame 佔 66%」只說了「在我們的回呼裡」，沒說是哪一段。
  const frames = complete.filter((e) => e.name === "FireAnimationFrame" && e.dur / 1000 >= 10);
  const inner = new Map();
  let frameTotal = 0;
  for (const f of frames) {
    frameTotal += f.dur / 1000;
    const kids = complete.filter(
      (e) => e.ts >= f.ts && e.ts + e.dur <= f.ts + f.dur && e !== f && e.name !== "RunTask",
    );
    const top = kids.filter((e) => !kids.some((o) => o !== e && o.ts <= e.ts && o.ts + o.dur >= e.ts + e.dur));
    for (const e of top) inner.set(e.name, (inner.get(e.name) ?? 0) + e.dur / 1000);
  }
  const innerRanked = [...inner.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`
  慢的 rAF 回呼 ${frames.length} 個，共 ${frameTotal.toFixed(0)} ms，裡面是：`);
  for (const [name, ms] of innerRanked) {
    console.log(`    ${name.padEnd(34)} ${ms.toFixed(1)} ms（${((ms / frameTotal) * 100).toFixed(0)}%）`);
  }
  const innerExplained = innerRanked.reduce((a, b) => a + b[1], 0);
  console.log(`    ${"（回呼裡沒有子事件的部分）".padEnd(28)} ${(frameTotal - innerExplained).toFixed(1)} ms（${(((frameTotal - innerExplained) / frameTotal) * 100).toFixed(0)}%）`);

  // GPUTask 有多少、多長 —— 那是 GPU 程序那一側的工作。
  const gpuTasks = complete.filter((e) => e.name === "GPUTask");
  const gpuMs = gpuTasks.reduce((a, b) => a + b.dur / 1000, 0);
  const gpuSorted = gpuTasks.map((t) => t.dur / 1000).sort((a, b) => a - b);
  if (gpuSorted.length > 0) {
    console.log(`
  GPUTask ${gpuTasks.length} 個，共 ${gpuMs.toFixed(0)} ms：p50 ${gpuSorted[gpuSorted.length >> 1].toFixed(2)} ms，最長 ${gpuSorted[gpuSorted.length - 1].toFixed(2)} ms`);
  }

  if (ranked.length > 0) {
    console.log(`  → 最大的一項是「${ranked[0][0]}」`);
  }
} catch (e) {
  console.log('失敗：' + String(e).split(String.fromCharCode(10))[0].slice(0, 220));
  process.exitCode = 1;
}
await browser.close();
server.close();
