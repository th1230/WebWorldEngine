/**
 * 完美遮蔽剔除最多能省多少 **GPU 時間**。
 *
 * 「80% 的物件看不見」不等於「有 80% 的時間可以省」：看不見的那些多半是
 * 遠處的小東西，而選階已經把它們變成幾個三角形、遠景合併已經把它們併進
 * 別人的繪製裡。也就是說**它要省的東西，這裡可能已經沒有了** —— 那正是
 * 多層 HLOD 被否決掉的同一個理由。
 *
 * 所以這裡裝一個作弊的完美剔除器：先畫一張 ID 圖知道誰真的看得見，把看不見
 * 的搬到視錐外，再量一次。相減就是上限。
 */
import { join } from 'node:path';
import { assertDistFresh } from '../lib/dist-fresh.mjs';
import { serveDist } from '../lib/serve.mjs';
import { launchBrowser } from '../lib/browser.mjs';
import { ROOT } from '../lib/repo-root.mjs';

// 關卡吃的是建好的產物 —— 它比原始碼舊的話，這一輪的每個數字都沒有意義。
assertDistFresh(ROOT);
const DIST = join(ROOT, 'apps/example/dist');
const COOKED = join(ROOT, 'apps/benchmark/public');
const site = await serveDist(DIST, { mounts: { '/cooked': COOKED } });

const SCENES = [
  ['遠景・兩萬個', 'count=20000&spread=900&orbit=520&hlod=0'],
  ['貼地看出去・六萬個', 'count=60000&spread=700&orbit=90&hlod=0'],
];

console.log('完美遮蔽剔除的上限（GPU 時間）\n');
const browser = await launchBrowser({ webgpu: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(180000);
page.setDefaultNavigationTimeout(180000);

try {
  for (const [label, query] of SCENES) {
    await page.goto(`${site.url}?${query}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ww?.totalFrames > 60, undefined, { timeout: 180000 });
    const split = await page.evaluate(() => window.__ww.classifyHidden());
    console.log(`  ${label}`);
    console.log(
      `    送出去 ${split.submitted.toLocaleString('en-US')}：看得見 ${split.visible.toLocaleString('en-US')}  太小 ${split.subPixel.toLocaleString('en-US')}  **被擋住 ${split.occluded.toLocaleString('en-US')}**`,
    );
    const proof = await page.evaluate(() => window.__ww.verifyOcclusionOracle());
    console.log(
      `    藏掉之後畫面差異：${proof.changed.toLocaleString('en-US')} / ${proof.pixels.toLocaleString('en-US')} 像素（${proof.changedPct}%），最大通道差 ${proof.worstChannelDelta}`,
    );
    const all = await page.evaluate(async () => window.__ww.measureOcclusionSaving(3, false));
    const out = await page.evaluate(async () => window.__ww.measureOcclusionSaving(3, true));
    console.log(
      `    完美可見性預言機（含太小的）：${all.baseMs} → ${all.oracleMs} ms，省 ${all.savedPct}%`,
    );
    console.log(
      `    交錯三輪 [base, oracle]：${out.rounds.map((r) => `[${r[0]}, ${r[1]}]`).join('  ')}`,
    );
    console.log(
      `    基準 ${out.baseMs} ms → 完美剔除 ${out.oracleMs} ms  **省 ${out.savedPct}%**\n`,
    );
  }
} catch (e) {
  console.log('失敗：' + String(e).split('\n')[0].slice(0, 160));
  process.exitCode = 1;
}
await page.close();
await browser.close();
site.close();
