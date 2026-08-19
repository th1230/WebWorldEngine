/**
 * 反射：畫面外的東西也要照得到。
 *
 * ## 這一關要證的就是那一句
 *
 * 紅箱子刻意擺在相機視錐外面。螢幕空間那一層追到畫面邊緣就沒資料了，距離場
 * 那一層在三維裡追得到。所以**把距離場關掉再量同一個像素**，就是最乾淨的
 * A/B —— 同一條著色器路徑、同一個像素，差別只有「有沒有第二層」。
 *
 * 而顏色要偏紅：那個紅在這個場景裡只有一個來源。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
import { listenSafe } from '../lib/listen-safe.mjs';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
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

console.log('反射：畫面外的東西也要照得到');
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
  page.setDefaultNavigationTimeout(240000);
  await page.goto(`${base}/?reflect=1&verify=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ww?.reflect != null, undefined, { timeout: 240000 });

  const out = await page.evaluate(async () => {
    const api = window.__ww.reflect;
    const onScreen = api.boxOnScreen();
    const greenOnScreen = api.greenOnScreen();
    const baked = await api.settle();

    api.render(true);
    const withField = { mirror: api.sample('mirror'), low: api.sample('mirrorLow'), green: api.sample('mirrorGreen') };
    const stats = api.stats();
    api.render(false);
    const withoutField = { mirror: api.sample('mirror'), low: api.sample('mirrorLow') };

    return { onScreen, greenOnScreen, baked, withField, withoutField, stats };
  });
  await page.close();

  const f = (v) => (Number.isFinite(v) ? v.toFixed(4) : String(v));
  const show = (c) => `${f(c[0])}, ${f(c[1])}, ${f(c[2])}  a=${f(c[3])}`;
  console.log(`  烘了 ${out.baked} 顆探針，紅箱子在畫面上：${out.onScreen}\n`);
  console.log(`  鏡子（有距離場）  ${show(out.withField.mirror)}`);
  console.log(`  鏡子（沒距離場）  ${show(out.withoutField.mirror)}`);
  console.log(`  鏡子下方（有）    ${show(out.withField.low)}\n`);

  console.log(`  整張：打到的比例 ${(out.stats.hit * 100).toFixed(2)}%，平均 ${f(out.stats.r)}, ${f(out.stats.g)}, ${f(out.stats.b)}`);
  const on = out.withField.mirror;
  const off = out.withoutField.mirror;

  check(
    out.onScreen === false,
    `紅箱子確實**不在**畫面上 —— 這是整關的前提，它若在畫面上就什麼都沒證明`,
  );
  check(Number.isFinite(on[0]) && Number.isFinite(off[0]), `取樣點都在畫面上`);
  check(on[3] > 0.5, `有距離場時追到東西了 —— alpha ${f(on[3])}`);
  check(off[3] < 0.5, `沒距離場時什麼都追不到 —— alpha ${f(off[3])}（螢幕空間看不到畫面外）`);
  check(on[0] > on[2] * 1.5, `反射到的顏色偏紅 —— R ${f(on[0])} vs B ${f(on[2])}（紅只可能來自那個箱子）`);
  check(
    on[0] > off[0] * 1.5,
    `同一個像素，開了第二層之後紅了 —— ${f(off[0])} → ${f(on[0])}`,
  );
  check(out.greenOnScreen === true, `綠箱子確實**在**畫面上 —— 螢幕空間那一層的前提`);
  check(
    out.withField.green[1] > out.withField.green[0] * 1.5 && out.withField.green[1] > out.withField.green[2] * 1.5,
    `螢幕空間那一層照得到畫面上的綠箱子 —— G ${f(out.withField.green[1])}（R ${f(out.withField.green[0])}、B ${f(out.withField.green[2])}）`,
  );
  // 整張的比例：抓得到「整片都打到」或「整片都沒打到」那一類粗的壞掉。
  // 抓**不到**起點偏移那一條 —— 實測拿掉只差 0.8 個百分點（35.65% vs
  // 36.45%），而那個差距訂成門檻會變成一條隨機紅的線（doctrine 第 17 條）。
  check(
    out.stats.hit > 0.2 && out.stats.hit < 0.6,
    `打到的比例合理 —— ${(out.stats.hit * 100).toFixed(2)}%（正確約 35.7%）`,
  );
  check(errors.length === 0, `沒有主控台錯誤${errors.length > 0 ? '：' + errors[0].slice(0, 140) : ''}`);
} catch (e) {
  console.log('失敗：' + String(e).split(String.fromCharCode(10))[0].slice(0, 240));
  failed++;
  process.exitCode = 1;
}
await browser.close();
server.close();

if (failed > 0) {
  console.log('');
  console.log(`反射關卡：${failed} 項沒過`);
  process.exit(1);
}
console.log('');
console.log('反射關卡：全過');
