/**
 * Impostor 對真幾何：快多少，以及像不像。
 *
 * 兩個判準缺一不可。只看「快多少」的話，把東西全部畫成兩個三角形當然最快
 * ——那不是優化，是把東西換掉。
 *
 * 之前用「把選階壓到最粗」當代理量過一次，結論是幾何沒剩多少可省。但最粗階
 * 還有幾十個三角形而 impostor 是兩個，代理與真東西差一個數量級 —— 所以這裡
 * 兩邊都真的做出來再量。
 */
import { join } from 'node:path';
import { assertDistFresh } from '../lib/dist-fresh.mjs';
import { serveDist } from '../lib/serve.mjs';
import { launchBrowser } from '../lib/browser.mjs';
import { ROOT } from '../lib/repo-root.mjs';
import { startReport } from '../lib/report.mjs';

// 關卡吃的是建好的產物 —— 它比原始碼舊的話，這一輪的每個數字都沒有意義。
assertDistFresh(ROOT);
const DIST = join(ROOT, 'apps/example/dist');
const site = await serveDist(DIST);

const COUNT = 20000;
const DISTANCES = [300, 700, 1500, 3000, 6000];
const SPREAD = 900;

const { markFailed, finish } = startReport('Impostor 對真幾何：同樣數量、同樣位置、同樣相機\n');
const browser = await launchBrowser({ webgpu: true });
const base = site.origin;

async function measure(page, distance, impostor) {
  await page.goto(
    `${base}/?trees=${COUNT}&spread=${SPREAD}&treeDist=${distance}${impostor ? '&impostor=1' : ''}`,
    {
      waitUntil: 'load',
    },
  );
  await page.waitForFunction(() => window.__ww?.totalFrames > 40, undefined, { timeout: 240000 });
  return page.evaluate(async () => {
    const gpu = await window.__ww.measureGpuMs(0, 1200, 15);
    window.__ww.step(0);
    const meta = window.__ww.impostor;
    const canvas = window.__ww.renderer.domElement;
    const flat = document.createElement('canvas');
    flat.width = canvas.width;
    flat.height = canvas.height;
    const ctx = flat.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    return {
      gpu: gpu.p50,
      calls: meta.calls,
      drawn: meta.drawnTriangles,
      pixels: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data),
    };
  });
}

try {
  for (const distance of DISTANCES) {
    // 交錯，這台機器的量測是雙峰的。
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultNavigationTimeout(240000);
    const real = await measure(page, distance, false);
    const fake = await measure(page, distance, true);
    await page.close();

    // 像不像：逐像素比。impostor 是近似，本來就會有差 —— 要問的是差多少。
    let differ = 0;
    for (let i = 0; i < real.pixels.length; i += 4) {
      const d = Math.max(
        Math.abs(real.pixels[i] - fake.pixels[i]),
        Math.abs(real.pixels[i + 1] - fake.pixels[i + 1]),
        Math.abs(real.pixels[i + 2] - fake.pixels[i + 2]),
      );
      if (d > 24) differ++;
    }
    const total = real.pixels.length / 4;

    console.log(`  相機距離 ${distance}`);
    console.log(
      `    真幾何    GPU ${real.gpu} ms，${real.calls} 次繪製，${real.drawn.toLocaleString('en-US')} 三角形`,
    );
    console.log(
      `    impostor  GPU ${fake.gpu} ms，${fake.calls} 次繪製，${fake.drawn.toLocaleString('en-US')} 三角形`,
    );
    const savedPct = ((real.gpu - fake.gpu) / real.gpu) * 100;
    const diffPct = (differ / total) * 100;
    console.log(`    **省 ${savedPct.toFixed(1)}%**，畫面差異 ${diffPct.toFixed(2)}%`);

    // ## 有一條線，不然這支只是在印數字
    //
    // doctrine 第 8 條：只印出來、沒有擋的數字等於沒有檢查。
    //
    // 判準是「**夠遠的時候**要看不出差別」—— 近處看板本來就不對，那不是
    // bug，是這個近似的本質。所以線畫在遠處那幾檔。
    if (distance >= 1500) {
      if (diffPct > 1) {
        console.log(`    ✗ 這個距離應該看不出差別，實際差 ${diffPct.toFixed(2)}%`);
        markFailed();
      }
      if (savedPct < 50) {
        console.log(`    ✗ 這個距離應該省很多，實際只省 ${savedPct.toFixed(1)}%`);
        markFailed();
      }
    }
    console.log('');
  }
} catch (e) {
  console.log('失敗：' + String(e).split('\n')[0].slice(0, 160));
  process.exitCode = 1;
}
await browser.close();
site.close();
// 「掛了也算沒過」那條守衛現在在 report.mjs 裡 —— 它本來是這一支
// 自己補的，收進去之後每一道關卡都有。
finish('Impostor 關卡');
