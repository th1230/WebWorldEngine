/**
 * 換階交叉淡入：抖動不可以在畫面上開洞。
 *
 * ## 最容易的失敗形態
 *
 * 抖動淡入是「同一個 instance 畫兩次，每個像素只留一次」。兩半的條件必須
 * **互補**（一個取 `<`，一個取 `>=`）——不互補的話中間那段會有一半的像素
 * 兩邊都被丟掉，畫面上是紗窗。
 *
 * ## 抓不到的那一個，講清楚
 *
 * 把 discard 整個拿掉（兩半都完整畫）量到 0.11%，而正確是 0.05% —— 只差
 * 兩倍，訂不出安全的門檻。原因很具體：兩個階的幾何差別本來就 ≤ errorPixels，
 * 所以「後面那個蓋掉前面那個」與「抖動混合」在畫面上本來就很像。
 *
 * 而那個破壞的後果是**退回今天的樣子**（直接換階），不是畫面壞掉。繪製那一
 * 側有單元測試守著（送了幾筆、進度多少），所以這裡不硬湊一條會隨機紅的線。
 *
 * 這一關真正守的是**紗窗**：抖動不互補（1.27%）或兩半分不清楚（1.27%）。
 *
 * 而那個症狀在單元測試裡看不見（繪製筆數、進度值全部正確），只有量畫面上
 * 蓋到多少像素才看得出來。這個專案已經有過「shader 沒編譯成功但數字都對」
 * 的紀錄，所以著色器的東西一定要從畫面反推。
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

console.log('換階交叉淡入：不可以開洞');
let failed = 0;
const check = (ok, message) => {
  console.log('  ' + (ok ? '\u2713' : '\u2717') + ' ' + message);
  if (!ok) failed++;
};

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const base = `http://localhost:${server.address().port}`;

const run = async (band) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.setDefaultNavigationTimeout(240000);
  await page.goto(`${base}/?count=600&spread=60&hlod=0&verify=1&lodFade=${band}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ww?.fadeCoverage != null && window.__ww.totalFrames > 30, undefined, {
    timeout: 240000,
  });
  // 掃一段距離，挑「過渡中最多」的那一個位置來比覆蓋率。
  const out = await page.evaluate(() => {
    // 先找過渡中最多的那個距離，再在那裡取縮圖。
    let best = { fading: -1, distance: 0 };
    for (let d = 80; d <= 500; d += 4) {
      const r = window.__ww.fadeCoverage(d);
      if (r.fading > best.fading) best = { fading: r.fading, distance: d };
    }
    return { ...best, signature: window.__ww.fadeSignature(best.distance) };
  });
  await page.close();
  return { ...out, errors };
};

try {
  const off = await run(0);
  const on = await run(0.6);
  console.log(`  沒淡入  距離 ${off.distance}，過渡中 ${off.fading}`);
  console.log(`  淡入    距離 ${on.distance}，過渡中 ${on.fading}`);

  // 兩張縮圖的平均差。抖動不互補的話中間那段是紗窗，縮圖上差得很明顯。
  let diff = 0;
  let scale = 0;
  for (let i = 0; i < off.signature.length; i++) {
    diff += Math.abs(on.signature[i] - off.signature[i]);
    scale += off.signature[i];
  }
  const relative = diff / Math.max(scale, 1e-6);
  console.log(`  兩張畫面的平均差 ${(relative * 100).toFixed(2)}%
`);

  check(on.fading > 0, `開了之後真的有 instance 在過渡 —— ${on.fading} 個`);
  check(off.fading === 0, `關掉時沒有任何過渡 —— ${off.fading} 個`);
  check(on.distance === off.distance, `兩邊在同一個距離上比 —— ${off.distance}`);
  check(
    // 量出來的：正確 0.05%，兩半改成同一個條件（紗窗）1.27%。
    // 0.4% 離正確值 8 倍、離壞掉 3 倍 —— 兩邊都有餘裕。
    relative < 0.004,
    `淡入之後畫面幾乎沒變，沒有紗窗 —— 差 ${(relative * 100).toFixed(2)}%（正確約 0.05%，抖動不互補會到 1.27%）`,
  );
  check(on.errors.length === 0, `著色器編譯得起來，沒有主控台錯誤${on.errors.length > 0 ? "：" + on.errors[0].slice(0, 140) : ""}`);
} catch (e) {
  console.log('失敗：' + String(e).split(String.fromCharCode(10))[0].slice(0, 240));
  failed++;
  process.exitCode = 1;
}
await browser.close();
server.close();

if (failed > 0) {
  console.log('');
  console.log(`換階淡入關卡：${failed} 項沒過`);
  process.exit(1);
}
console.log('');
console.log('換階淡入關卡：全過');
