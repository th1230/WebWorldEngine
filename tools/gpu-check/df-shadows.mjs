/**
 * 距離場陰影：遠處也要有形狀，而不是一片糊或一片黑。
 *
 * ## 判準
 *
 * 箱高 30、光的仰角約 31 度，所以影子大約 50 單位長。−30 那一點在影子裡，
 * −120 那一點在影子外，側面 90 單位那一點也在影子外。
 *
 * 三個點加上「暗掉的像素比例」——後者是接觸陰影那一輪學到的：手放的取樣點
 * 只驗得到想得到的位置，而「整片變暗」那一類 bug 只有看整張才量得到。
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

console.log('距離場陰影：遠處也要有形狀');
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
  page.setDefaultNavigationTimeout(180000);
  await page.goto(`${base}/?dfshadow=1&verify=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ww?.dfShadow != null, undefined, { timeout: 180000 });

  const out = await page.evaluate(() => {
    const api = window.__ww.dfShadow;
    const rounds = api.settle();
    api.render();
    const on = {
      shadow: api.sample('shadow'),
      open: api.sample('open'),
      behind: api.sample('behind'),
      outside: api.sample('outside'),
      boxTop: api.sample('boxTop'),
      terminator: api.sample('terminator'),
      coverage: api.coverage(),
    };
    // 換相機角度再量同一個世界座標 —— 法線沒換回世界的話會跟著相機變。
    api.setCameraAngle(1);
    api.render();
    const other = { shadow: api.sample("shadow"), open: api.sample("open"), terminator: api.sample("terminator") };
    api.setCameraAngle(0);
    api.render();
    api.setStrength(0);
    api.render();
    const off = { shadow: api.sample('shadow'), coverage: api.coverage() };
    api.setStrength(1);
    return { rounds, pending: api.pending(), on, off, other };
  });
  await page.close();

  const f = (v) => v.toFixed(3);
  console.log(`  場算完了：${out.rounds} 輪，還欠 ${out.pending} 格\n`);
  console.log(`  影子裡   開 ${f(out.on.shadow)}   關 ${f(out.off.shadow)}`);
  console.log(`  影子外   開 ${f(out.on.open)}`);
  console.log(`  側面     開 ${f(out.on.behind)}`);
  console.log(`  場外面   開 ${f(out.on.outside)}`);
  console.log(`  箱頂     開 ${f(out.on.boxTop)}`);
  console.log(`  另一個相機角度：影子裡 ${f(out.other.shadow)}，影子外 ${f(out.other.open)}`);
  console.log(`  暗掉的像素比例 開 ${(out.on.coverage * 100).toFixed(2)}%   關 ${(out.off.coverage * 100).toFixed(2)}%\n`);

  // 取樣點跑出畫面會回 NaN —— 那代表場景擺錯了，不是效果錯了。要先擋下來，
  // 否則後面每一條斷言都在比較 NaN（而 NaN 的比較永遠是 false，看起來像效果壞了）。
  const values = [out.on.shadow, out.on.open, out.on.behind, out.on.outside, out.on.boxTop, out.on.terminator, out.other.shadow, out.other.open, out.other.terminator];
  check(values.every((v) => Number.isFinite(v)), `每個取樣點都在畫面上 —— ${values.map(f).join(", ")}`);
  check(out.pending === 0, `距離場算完整了 —— 還欠 ${out.pending} 格`);
  check(out.on.shadow < 0.6, `影子裡真的暗了 —— ${f(out.on.shadow)}`);
  check(out.on.open > 0.9, `影子外沒有被暗掉 —— ${f(out.on.open)}（影子只有約 12 單位長）`);
  check(out.on.behind > 0.9, `與光垂直的那一側也沒有 —— ${f(out.on.behind)}`);
  check(
    out.on.shadow < out.on.open - 0.3,
    `影子裡外差得夠開 —— 差 ${f(out.on.open - out.on.shadow)}`,
  );
  check(
    out.on.coverage > 0.05 && out.on.coverage < 0.25,
    `暗的是一塊影子而不是整個畫面 —— ${(out.on.coverage * 100).toFixed(2)}%（正確約 14.3%：一個箱子加一顆球的影子）`,
  );
  check(
    out.on.outside > 0.9,
    `場外面沒有資料，不代表那裡有東西 —— ${f(out.on.outside)}（越界回 0 的話這裡會全黑）`,
  );
  check(
    Math.abs(out.other.shadow - out.on.shadow) < 0.25 &&
      Math.abs(out.other.open - out.on.open) < 0.25 &&
      Math.abs(out.other.terminator - out.on.terminator) < 0.25,
    `換相機角度之後同樣的世界座標答案一樣 —— 影子裡 ${f(out.on.shadow)}/${f(out.other.shadow)}，影子外 ${f(out.on.open)}/${f(out.other.open)}，球的明暗交界 ${f(out.on.terminator)}/${f(out.other.terminator)}`,
  );
  check(
    out.on.boxTop > 0.9,
    `箱子自己的受光面是亮的 —— ${f(out.on.boxTop)}（少了沿法線的偏移，這裡會全黑）`,
  );
  check(out.off.shadow > 0.9, `強度歸零之後影子也沒了 —— ${f(out.off.shadow)}（證明暗的是這個效果畫的）`);
  check(errors.length === 0, `沒有主控台錯誤${errors.length > 0 ? '：' + errors[0].slice(0, 140) : ''}`);
} catch (e) {
  console.log('失敗：' + String(e).split(String.fromCharCode(10))[0].slice(0, 220));
  failed++;
  process.exitCode = 1;
}
await browser.close();
server.close();

if (failed > 0) {
  console.log('');
  console.log(`距離場陰影關卡：${failed} 項沒過`);
  process.exit(1);
}
console.log('');
console.log('距離場陰影關卡：全過');
