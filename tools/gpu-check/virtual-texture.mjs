/**
 * 虛擬貼圖真的畫出來了嗎 —— 而且畫的是對的那一頁嗎。
 *
 * ## 為什麼要從畫面反推
 *
 * 這個專案有過「shader 根本沒編譯成功，但『省了 95.5%』印得好好的，畫面
 * 全黑」的紀錄。內部數字不能證明畫面是對的。
 *
 * 所以每一頁填成純色，而**顏色由階數與頁座標算出來**。從畫面上讀一個像素
 * 反推回 (level, px, py)，對得上才算過。取樣到隔壁頁、取樣到錯的階、頁表
 * 被內插糊掉 —— 這三種錯都會讓反推出來的座標對不上。
 *
 * ## 而它要證明的事情本身
 *
 * 假裝出來的解析度**必須超過這台機器的 maxTextureSize**。沒超過的話這整個
 * 東西沒有存在的理由（直接配置一張就好），所以那也是一條斷言。
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
  if (path === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  const file = join(DIST, path === '/' ? 'index.html' : path);
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

/** 與場景裡那一份**必須一致** —— 對不上的話這個關卡驗的是自己，不是引擎。 */
const pageColor = (level, px, py) => [
  40 + level * 20,
  30 + ((px * 37 + 20) % 200),
  30 + ((py * 61 + 40) % 200),
];

console.log('虛擬貼圖：假裝出來的比硬體上限大，而且取樣到對的那一頁\n');
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu'],
});
const base = `http://localhost:${server.address().port}`;
let failed = 0;
const check = (ok, message) => {
  console.log(`  ${ok ? '✓' : '✗'} ${message}`);
  if (!ok) failed++;
};

try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.setDefaultNavigationTimeout(120000);
  await page.goto(`${base}/?vt=1&verify=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ww?.totalFrames > 5, undefined, { timeout: 120000 });

  const info = await page.evaluate(() => ({
    virtualSize: window.__ww.vt.virtualSize,
    atlasSize: window.__ww.vt.atlasSize,
    levels: window.__ww.vt.levels,
    maxTextureSize: window.__ww.vt.maxTextureSize,
  }));

  console.log(
    `  假裝 ${info.virtualSize}×${info.virtualSize}，實際配置 ${info.atlasSize}×${info.atlasSize}，${info.levels} 階`,
  );
  console.log(`  這台機器的 maxTextureSize：${info.maxTextureSize}\n`);

  check(
    info.virtualSize > info.maxTextureSize,
    `假裝出來的比硬體上限大 —— ${info.virtualSize} > ${info.maxTextureSize}（沒超過的話這東西沒有存在理由）`,
  );
  check(info.atlasSize <= info.maxTextureSize, `真正配置的那張在上限內 —— ${info.atlasSize}`);

  /**
   * 讀畫面上某個比例位置的顏色。
   *
   * 在頁面裡讀 —— 預設 framebuffer 合成之後就清掉了，從外面 readPixels
   * 讀到的是全黑，而全黑看起來就像「shader 沒編譯成功」。兩種完全不同的
   * 問題長得一樣，那種量測不能用。
   */
  const pixelAt = (u, v) => page.evaluate(([uu, vv]) => window.__ww.vt.sampleAt(uu, vv), [u, v]);
  // ── 一、什麼都還沒要的時候，整張是最粗那一階 ──────────────
  const coarse = pageColor(info.levels - 1, 0, 0);
  const before = await pixelAt(0.5, 0.5);
  check(
    Math.abs(before[0] - coarse[0]) < 12 &&
      Math.abs(before[1] - coarse[1]) < 12 &&
      Math.abs(before[2] - coarse[2]) < 12,
    `還沒載任何細頁時整張是最粗那階（糊，但不是垃圾）—— 讀到 ${before}，該是 ${coarse}`,
  );

  // ── 二、要一頁進來，那一塊就變成那一頁 ────────────────────
  // 選一個一邊 8 頁的階：每頁佔畫面 1/8 = 64 px，量得動。
  const level = await page.evaluate(() => {
    for (let l = 0; l < window.__ww.vt.levels; l++) if (window.__ww.vt.sideAt(l) === 8) return l;
    return -1;
  });
  check(level >= 0, `找得到一邊 8 頁的那一階 —— 第 ${level} 階`);

  const target = [3, 5];
  await page.evaluate(
    ([l, px, py]) => {
      window.__ww.vt.request(l, px, py);
      window.__ww.vt.update(8);
    },
    [level, target[0], target[1]],
  );
  await page.waitForFunction(() => window.__ww.vt.pagesLoaded > 0, undefined, { timeout: 30000 });
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );

  const want = pageColor(level, target[0], target[1]);
  // 那一頁的中心：(px + 0.5) / 8
  const inside = await pixelAt((target[0] + 0.25) / 8, (target[1] + 0.25) / 8);
  check(
    Math.abs(inside[0] - want[0]) < 12 &&
      Math.abs(inside[1] - want[1]) < 12 &&
      Math.abs(inside[2] - want[2]) < 12,
    `要進來的那一頁畫在對的位置 —— 讀到 ${inside}，該是 ${want}`,
  );

  // ── 三、沒要的地方還是粗的（不是整張都變了）────────────────
  // 沒要的那一塊要取在**最粗那一頁的左下象限**（u、v 都小於 0.5）——
  // 右上象限的記號是對調的，取在那裡讀到的是對調過的顏色，而那不是錯。
  const outside = await pixelAt(1.5 / 8, 1.5 / 8);
  check(
    Math.abs(outside[0] - coarse[0]) < 12 &&
      Math.abs(outside[1] - coarse[1]) < 12 &&
      Math.abs(outside[2] - coarse[2]) < 12,
    `沒要的地方還是回退到粗階 —— 讀到 ${outside}，該是 ${coarse}`,
  );
  check(
    want[1] !== coarse[1] || want[2] !== coarse[2],
    '兩個顏色本來就不同 —— 否則上面兩條在同一個顏色上互相抵銷',
  );

  // ── 四、換一頁，畫面跟著換 ────────────────────────────────
  const second = [6, 2];
  await page.evaluate(
    ([l, px, py]) => {
      window.__ww.vt.request(l, px, py);
      window.__ww.vt.update(8);
    },
    [level, second[0], second[1]],
  );
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const want2 = pageColor(level, second[0], second[1]);
  const at2 = await pixelAt((second[0] + 0.25) / 8, (second[1] + 0.25) / 8);
  check(
    Math.abs(at2[0] - want2[0]) < 12 &&
      Math.abs(at2[1] - want2[1]) < 12 &&
      Math.abs(at2[2] - want2[2]) < 12,
    `第二頁也對得上（頁表換了之後真的生效）—— 讀到 ${at2}，該是 ${want2}`,
  );

  // ── 五、頁**裡面**的 UV 也要對 ─────────────────────────────
  //
  // 純色的頁只驗得出「選到哪一頁」，驗不出「頁裡面取樣到哪一點」。每頁的
  // 右上象限把 G 與 B 對調，所以那兩個位置該讀到對調過的顏色。
  //
  // 沒有這一條的話，把著色器裡的階數縮放寫死成 1.0 也照樣全過（實測）。
  const swapped = [want[0], want[2], want[1]];
  const upperRight = await pixelAt((target[0] + 0.75) / 8, (target[1] + 0.75) / 8);
  check(
    Math.abs(upperRight[0] - swapped[0]) < 12 &&
      Math.abs(upperRight[1] - swapped[1]) < 12 &&
      Math.abs(upperRight[2] - swapped[2]) < 12,
    `頁裡面的位置也對得上（右上象限是對調的）—— 讀到 ${upperRight}，該是 ${swapped}`,
  );
  check(want[1] !== want[2], `記號分得出來 —— G ${want[1]} 與 B ${want[2]} 本來就不同`);

  check(
    errors.length === 0,
    `沒有主控台錯誤${errors.length > 0 ? '：' + errors[0].slice(0, 120) : ''}`,
  );
  await page.close();
} catch (e) {
  console.log('失敗：' + String(e).split('\n')[0].slice(0, 200));
  failed++;
  process.exitCode = 1;
}
await browser.close();
server.close();

if (failed > 0) {
  console.log(`\n虛擬貼圖關卡：${failed} 項沒過`);
  process.exit(1);
}
console.log('\n虛擬貼圖關卡：全過');
