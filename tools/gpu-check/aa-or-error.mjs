import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { assertDistFresh } from '../lib/dist-fresh.mjs';
import { serveDist } from '../lib/serve.mjs';
import { ROOT } from '../lib/repo-root.mjs';
import { launchBrowser } from '../lib/browser.mjs';

/**
 * 接長鏈之後多出來的那 0.02%，是**抗鋸齒**還是**真的位移超過 2 像素**？
 *
 * ## 為什麼這個問題卡住一個功能
 *
 * `extendLodChain` 開了之後 `visual-check` 的多畫是 0.471%，門檻 0.45%。
 * 其他證據都說沒事：少畫 0.21%（遠低於上限）、梯度比 11.0（整組最高，代表
 * 差異集中在輪廓上，正是契約允許的那一種）。
 *
 * 但梯度比只說明差異的**種類**，不說明**大小**。而多畫本來就是「位移超過
 * 2 像素」的計數。所以兩種解釋都成立，而它們的結論完全相反：
 *
 * - 殘餘的低估 → 契約還是破的，這個功能不該開
 * - 抗鋸齒 → 契約是好的，只是量尺在邊界上抖，功能可以開
 *
 * ## 怎麼分辨：換解析度
 *
 * 選階是依**螢幕誤差**的，所以解析度變高時引擎會挑更細的階來守住 2 像素 ——
 * **真正的位移量（以像素計）不隨解析度改變**。
 *
 * 抗鋸齒不一樣：它影響的是輪廓上那一圈像素，數量隨解析度**線性**成長，而
 * 總像素數是**平方**成長。所以抗鋸齒造成的「不合像素**佔比**」會隨解析度
 * 大致以 1/邊長 下降。
 *
 * | 邊長加倍後多畫的佔比 | 結論 |
 * | --- | --- |
 * | 大約減半 | 抗鋸齒 |
 * | 幾乎不變 | 真的有位移超過 2 像素 |
 *
 * ## 這不是 gate
 *
 * 它回答的是「那個功能能不能預設開」，是一次性的判斷，不是每次都要重跑的
 * 迴歸檢查。
 */

// 關卡吃的是建好的產物 —— 它比原始碼舊的話，這一輪的每個數字都沒有意義。
assertDistFresh(ROOT);
const DIST = join(ROOT, 'apps/example/dist');

/** 就是 `visual-check` 裡紅掉的那兩個模式。 */
const MODES = [
  { name: '靜態（一次擺完）', query: '?count=20000&hlodBudgetMB=512&verify=1' },
  { name: '串流（區塊表）', query: '?stream=1&hlodBudgetMB=512&verify=1' },
];

/** 邊長逐次加倍。t 固定在 visual-check 報出來的最差角度附近。 */
const SIZES = [
  [640, 360],
  [1280, 720],
  [2560, 1440],
];

async function main() {
  console.log('建置 example…');
  execFileSync('pnpm', ['--filter', '@ww/example-app', 'build'], {
    cwd: ROOT,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  const site = await serve(DIST);
  const browser = await launchBrowser();
  try {
    for (const mode of MODES) {
      for (const extend of [false, true]) {
        console.log(`\n${mode.name}   接長鏈 ${extend ? '開' : '關'}`);
        let previous = null;
        for (const [width, height] of SIZES) {
          const page = await browser.newPage({ viewport: { width, height } });
          await page.goto(site.url + mode.query + (extend ? '&extendLod=1' : ''), {
            waitUntil: 'load',
          });
          await page.waitForFunction(() => window.__ww?.totalFrames > 60, undefined, {
            timeout: 60_000,
          });
          const r = await page.evaluate(
            ([w, h]) => window.__ww.verifyQuality(6.4, 2, 8, w, h),
            [width, height],
          );
          await page.close();

          const shrink =
            previous === null ? '' : `   前一段的 ${(r.percent / previous).toFixed(2)} 倍`;
          console.log(
            `  ${String(width).padStart(4)}×${String(height).padEnd(4)}` +
              `   多畫 ${r.percent.toFixed(3)}%   少畫 ${r.missingPercent.toFixed(3)}%${shrink}`,
          );
          previous = r.percent;
        }
      }
    }
  } finally {
    await browser.close();
    site.close();
  }
  console.log('\n判讀：每次邊長加倍，多畫佔比若大約減半 → 抗鋸齒；幾乎不變 → 真的有位移。');
}

async function serve(dir) {
  const COOKED = join(ROOT, 'apps/benchmark/public');
  const site = await serveDist(dir, { mounts: { '/cooked': COOKED } });
  return { url: site.url, close: () => site.close() };
}

await main();
