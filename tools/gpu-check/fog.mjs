/**
 * 體積霧：光柱要被擋住，不可以穿牆。
 *
 * ## 判準就是那一句
 *
 * 體積霧不難，難的是「這一點被照到嗎」。沒有那個資訊的話光柱會穿過牆、穿過
 * 屋頂 —— 而那不是不夠準，是看起來就是假的，因為光柱的形狀正是它撞到什麼的
 * 形狀。
 *
 * 所以把距離場關掉再量同一個像素，就是這件事最乾淨的 A/B：**同一條著色器
 * 路徑、同一個像素，差別只有「知不知道那裡有牆」**。
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

console.log('體積霧：光柱要被擋住');
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
  await page.goto(`${base}/?fog=1&verify=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ww?.fog != null, undefined, { timeout: 240000 });

  const out = await page.evaluate(() => {
    const api = window.__ww.fog;
    api.settle();
    api.render(true);
    const withField = {
      shadow: api.sample('behindWall'),
      open: api.sample('throughGap'),
      variance: api.variance('sky'),
    };
    api.render(false);
    const withoutField = { shadow: api.sample('behindWall'), open: api.sample('throughGap') };
    return { withField, withoutField };
  });
  await page.close();

  const f = (v) => (Number.isFinite(v) ? v.toFixed(4) : String(v));
  const lum = (c) => (c[0] + c[1] + c[2]) / 3;
  console.log(`  有距離場  牆後面 ${f(lum(out.withField.shadow))}   缺口 ${f(lum(out.withField.open))}`);
  console.log(`  沒距離場  牆後面 ${f(lum(out.withoutField.shadow))}   缺口 ${f(lum(out.withoutField.open))}`);
  console.log(`  透光率    影子裡 ${f(out.withField.shadow[3])}   影子外 ${f(out.withField.open[3])}\n`);

  const onShadow = lum(out.withField.shadow);
  const onOpen = lum(out.withField.open);
  const offShadow = lum(out.withoutField.shadow);
  const offOpen = lum(out.withoutField.open);

  check(Number.isFinite(onShadow) && Number.isFinite(onOpen), `取樣點都在畫面上`);
  check(onOpen > 0.01, `缺口那邊有明顯的光柱 —— 散射光 ${f(onOpen)}`);
  check(
    onShadow < onOpen * 0.2,
    `牆後面暗得多 —— ${f(onShadow)} vs ${f(onOpen)}（差 ${(onOpen / Math.max(onShadow, 1e-6)).toFixed(0)} 倍）`,
  );

  // ## 「關掉距離場兩邊就一樣」是錯的判準
  //
  // 沒有場的時候，牆後面那條射線**還是會停在牆上**（深度緩衝擋住了），所以
  // 它走得比較短、累積的霧比較少。那是幾何，不是遮蔽。第一版拿「兩邊要一樣」
  // 當判準，於是紅了 —— 而紅的是判準不是效果。
  //
  // 乾淨的 A/B 是**同一個像素**開關場：牆後面應該暗一大截，而缺口那邊幾乎
  // 不受影響。兩者的比值差距就是遮蔽本身。
  const shadowDrop = offShadow / Math.max(onShadow, 1e-6);
  const openDrop = offOpen / Math.max(onOpen, 1e-6);
  console.log(`  同一個像素開關場：牆後面 ${f(offShadow)} → ${f(onShadow)}（${shadowDrop.toFixed(1)}×），缺口 ${f(offOpen)} → ${f(onOpen)}（${openDrop.toFixed(1)}×）`);
  check(shadowDrop > 5, `開了場之後牆後面暗一大截 —— ${shadowDrop.toFixed(1)} 倍`);
  check(openDrop < 2.5, `而缺口那邊幾乎不受影響 —— ${openDrop.toFixed(1)} 倍`);
  check(
    shadowDrop > openDrop * 3,
    `遮蔽只打在該打的地方 —— 牆後面 ${shadowDrop.toFixed(1)}× vs 缺口 ${openDrop.toFixed(1)}×`,
  );
  // 量出來的上下界（正確值在括號裡）：
  //
  // | 弄壞什麼 | 缺口 | 牆後面 | 缺口的相鄰變異 |
  // | --- | ---: | ---: | ---: |
  // | 正確 | **0.2222** | **0.0032** | **見下** |
  // | 拿掉相位函數 | 0.2270 | 0.0111 | |
  // | 拿掉透光衰減 | 0.3694 | 0.0033 | |
  // | 拿掉起點抖動 | 0.2242 | 0.0031 | 幾乎 0 |
  // | 越界回 0 | 0.1855 | 0.0032 | |
  //
  // 最後一列（0.1855 對 0.2222）差 17%，訂成門檻太緊 —— 而距離場陰影那一
  // 關已經正面驗過它（場外面的地面要是亮的），所以這裡不重複。
  check(
    onOpen < 0.28,
    `散射有隨著霧衰減 —— 缺口 ${f(onOpen)}（不衰減會到 0.37）`,
  );
  check(
    onOpen / Math.max(onShadow, 1e-6) > 40,
    `相位函數有生效 —— 缺口／牆後面 ${(onOpen / Math.max(onShadow, 1e-6)).toFixed(0)} 倍（沒有相位只有 20 倍）`,
  );
  check(
    // 量出來的：抖動 5.57%，固定起點 2.95%（步數壓到 10 才分得開 —— 48 步時
    // 只差 7%）。4% 這條線離兩邊各 1.4 倍。
    out.withField.variance > 0.04,
    `起點有抖動 —— 相鄰像素的相對變異 ${(out.withField.variance * 100).toFixed(2)}%（固定起點是 2.95%）`,
  );
  check(
    out.withField.open[3] > 0 && out.withField.open[3] < 1,
    `透光率在 0 與 1 之間 —— ${f(out.withField.open[3])}`,
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
  console.log(`體積霧關卡：${failed} 項沒過`);
  process.exit(1);
}
console.log('');
console.log('體積霧關卡：全過');
