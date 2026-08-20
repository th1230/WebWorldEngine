/**
 * 接觸尺度的反彈光：探針網格抓不抓得到，以及那是不是解析度問題。
 *
 * ## 為什麼問這個
 *
 * 動態重烘做完之後，會動的東西反彈得了光。剩下的缺口是**尺度**：探針是一格
 * 一格的，格距 10 個單位的話，一個貼著牆的小東西造成的反彈落在格與格之間。
 *
 * 那正是螢幕空間 GI 補的東西。而在決定要不要做那個之前該先問：
 *
 * > 把探針加密，抓得到嗎？
 *
 * 抓得到的話這就是一個**旋鈕**（而且烘一顆只要 2.7 ms，加密付得起），不是
 * 一個缺掉的功能。抓不到的話才輪得到螢幕空間那條路。
 *
 * ## 判準還是顏色
 *
 * 與 gi-check 同一個邏輯：場景裡除了那塊板子沒有藍色。板子貼到箱子旁邊之後
 * 那一面沾到多少藍，就是探針抓到多少。
 */
import { join } from 'node:path';
import { assertDistFresh } from '../lib/dist-fresh.mjs';
import { serveDist } from '../lib/serve.mjs';
import { launchBrowser } from '../lib/browser.mjs';
import { ROOT } from '../lib/repo-root.mjs';

// 關卡吃的是建好的產物 —— 它比原始碼舊的話，這一輪的每個數字都沒有意義。
assertDistFresh(ROOT);
const DIST = join(ROOT, 'apps/example/dist');
const site = await serveDist(DIST);

console.log('接觸尺度：板子貼到箱子旁邊，探針抓得到多少藍\n');
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 800, height: 480 } });

for (const res of [4, 8, 16, 24]) {
  await page.goto(`${site.url}?gi=1&probeRes=${res}`, {
    waitUntil: 'load',
  });
  await page.waitForFunction(
    () => window.__ww?.gi !== null && window.__ww?.gi !== undefined,
    undefined,
    {
      timeout: 180000,
    },
  );
  const out = await page.evaluate(async () => {
    const gi = window.__ww.gi;
    let rounds = 0;
    while (gi.stats().baked < gi.stats().probes && rounds < 4000) {
      await gi.bake();
      rounds++;
    }
    const at = [-5, 14, -5];
    const n = [-0.707, 0, -0.707];
    const before = gi.sampleCpu(at, n);
    // **貼著**箱子那一面（箱子半徑 5，所以 −6.5 只差 1.5 個單位）。
    const marked = gi.moveBlocker(-6.5, 14, -6.5);
    const rebaked = await gi.bakeStale();
    const after = gi.sampleCpu(at, n);
    return { before, after, probes: gi.stats().probes, marked, rebaked };
  });
  const gain = out.after[2] - out.before[2];
  console.log(
    `  解析度 ${String(res).padStart(2)}（${String(out.probes).padStart(5)} 顆）  ` +
      `藍 ${out.before[2].toFixed(4)} → ${out.after[2].toFixed(4)}  Δ ${gain.toFixed(4)}  標 ${out.marked} 重烘 ${out.rebaked}`,
  );
}

await browser.close();
site.close();
