/**
 * 接觸陰影：暗的地方要在接縫上，不是整片。
 *
 * ## 為什麼要有「不該暗」的對照點
 *
 * 只驗「有東西變暗了」會被自我遮蔽的 bug 騙過去 —— 那個 bug 讓**整片**變暗，
 * 而整片變暗也滿足「有變暗」。所以這裡同時驗兩個不該暗的點：空曠的地面，
 * 以及迎光那一側。
 *
 * 判準的形狀與間接光那一條一樣（「背光面偏紅，而紅只可能來自紅牆」）：訊號
 * 要有乾淨的來源，而且要有一個不該有訊號的對照點。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
import { listenSafe } from '../lib/listen-safe.mjs';
import { assertDistFresh } from '../lib/dist-fresh.mjs';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// 關卡吃的是建好的產物 —— 它比原始碼舊的話，這一輪的每個數字都沒有意義。
assertDistFresh(root);
const DIST = join(root, 'apps/example/dist');
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (path === '/favicon.ico') { res.writeHead(204).end(); return; }
  const file = join(DIST, path === '/' ? 'index.html' : path);
  readFile(file).then(
    (b) => { res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }[extname(file)] ?? 'application/octet-stream' }); res.end(b); },
    () => res.writeHead(404).end(),
  );
});
await listenSafe(server);

console.log('接觸陰影：暗在接縫上，不是整片\n');
let failed = 0;
const check = (ok, message) => {
  console.log('  ' + (ok ? '\u2713' : '\u2717') + ' ' + message);
  if (!ok) failed++;
};

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const base = `http://localhost:${server.address().port}`;

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.setDefaultNavigationTimeout(120000);
  await page.goto(`${base}/?contact=1&verify=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ww?.contact != null, undefined, { timeout: 120000 });

  const out = await page.evaluate(() => {
    const api = window.__ww.contact;
    const all = () => ({
      contact: api.sample('contact'),
      open: api.sample('open'),
      lit: api.sample('lit'),
      terminator: api.sample('terminator'),
      under: api.sample('under'),
    });
    api.setCameraAngle(0);
    api.render();
    const on = all();
    const coverage = api.coverage();
    // 換一個相機角度再量同一個世界座標。光的方向沒換到視空間的話，陰影會
    // 跟著相機轉 —— 而那在靜止的相機下完全看不出來。
    api.setCameraAngle(1);
    api.render();
    const other = { contact: api.sample('contact') };
    api.setCameraAngle(0);
    // 強度歸零 = 同一條著色器路徑但不該有陰影。
    api.setStrength(0);
    api.render();
    const off = all();
    api.setStrength(0.9);
    return { on, off, other, coverage };
  });
  await page.close();

  const f = (v) => v.toFixed(3);
  console.log(`  接縫處     開 ${f(out.on.contact)}   關 ${f(out.off.contact)}`);
  console.log(`  空曠地     開 ${f(out.on.open)}   關 ${f(out.off.open)}`);
  console.log(`  迎光側     開 ${f(out.on.lit)}   關 ${f(out.off.lit)}`);
  console.log(`  球的明暗界 開 ${f(out.on.terminator)}   關 ${f(out.off.terminator)}`);
  console.log(`  浮空箱下方 開 ${f(out.on.under)}   關 ${f(out.off.under)}`);
  console.log(`  接縫（另一個相機角度） ${f(out.other.contact)}`);
  console.log("");

  check(out.on.contact < 0.75, `接縫處真的暗了 —— ${f(out.on.contact)}（1 是沒遮蔽）`);
  check(out.on.open > 0.95, `空曠的地面沒有被暗掉 —— ${f(out.on.open)}`);
  check(out.on.lit > 0.95, `迎光那一側也沒有 —— ${f(out.on.lit)}`);
  check(
    out.on.terminator > 0.9,
    `球體的明暗交界沒有自己遮住自己 —— ${f(out.on.terminator)}（沒有法線偏移的話這裡會變黑）`,
  );
  check(
    out.on.under > 0.9,
    `浮在空中的箱子沒有在地面投下假影子 —— ${f(out.on.under)}（沒有厚度上限的話這裡會變黑）`,
  );
  check(
    Math.abs(out.other.contact - out.on.contact) < 0.25,
    `換相機角度之後同一個世界座標的陰影一樣 —— ${f(out.on.contact)} vs ${f(out.other.contact)}`,
  );
  // 暗掉的**範圍**：手放的取樣點驗不到「整片變暗」那一類 bug（實測拿掉法線
  // 偏移與厚度上限，五個點一個都沒變）。範圍只有看整張才量得到。
  console.log(`  暗掉的像素比例 ${(out.coverage * 100).toFixed(2)}%`);
  // ## 上界是量出來的，不是猜的
  //
  // 把兩個保護各拿掉一次，量到的暗掉比例是：
  //
  // | | 暗掉的比例 |
  // | --- | ---: |
  // | 正確 | **0.52%** |
  // | 拿掉法線偏移（自我遮蔽） | 2.80% |
  // | 拿掉厚度上限（遠方假遮蔽） | 5.62% |
  //
  // 1.5% 這條線離正確值 2.9 倍、離最近的壞情況 1.9 倍 —— 兩邊都有餘裕，
  // 不會變成一條會隨機紅的線。
  check(
    out.coverage > 0.001 && out.coverage < 0.015,
    `暗的範圍是接縫而不是一大片 —— ${(out.coverage * 100).toFixed(2)}%（自我遮蔽會到 2.8%，遠方假遮蔽會到 5.6%）`,
  );
  check(out.off.contact > 0.95, `強度歸零之後接縫也不暗了 —— ${f(out.off.contact)}（證明暗的是這個效果畫的）`);
  check(errors.length === 0, `沒有主控台錯誤${errors.length > 0 ? "：" + errors[0].slice(0, 120) : ""}`);
} catch (e) {
  console.log('失敗：' + String(e).split(String.fromCharCode(10))[0].slice(0, 220));
  failed++;
  process.exitCode = 1;
}
await browser.close();
server.close();

if (failed > 0) {
  console.log('');
  console.log(`接觸陰影關卡：${failed} 項沒過`);
  process.exit(1);
}
console.log('');
console.log('接觸陰影關卡：全過');
