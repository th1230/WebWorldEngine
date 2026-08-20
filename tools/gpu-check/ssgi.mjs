/**
 * 螢幕空間間接光：它到底有沒有在做事。
 *
 * 判準與 gi-check 同一個 —— **顏色**。紅房間、白箱子、沒有環境光，箱子的
 * 背光面拿不到任何直接光。那一面上出現的紅只可能是從紅地板／紅牆反彈來的。
 *
 * 這裡量的是 SSGI **自己的輸出**（收集到的那張圖），不是合成之後的畫面 ——
 * 合成之後量的話混著直接光，分不出是誰貢獻的。
 *
 * 探針那條路的同一個位置量到 R 94.9 / B 37.6（紅比藍高 57）。兩邊量的是
 * 同一件事，所以數字直接可比。
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

const { check, fail, finish } = startReport('螢幕空間間接光：背光面收集到的顏色\n');
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 800, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).split('\n')[0].slice(0, 100)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().split('\n')[0].slice(0, 100));
});

try {
  // 探針**關掉**（intensity 0），這樣量到的完全是 SSGI 的貢獻。
  const radius = process.argv[2] ?? 12;
  await page.goto(`${site.url}?gi=1&giOff=1&ssgiRadius=${radius}`, {
    waitUntil: 'load',
  });
  await page.waitForFunction(
    () => window.__ww?.gi !== null && window.__ww?.gi !== undefined,
    undefined,
    {
      timeout: 180000,
    },
  );

  const out = await page.evaluate(() => {
    const api = window.__ww;
    api.step(0);
    const canvas = api.renderer.domElement;
    // 與 gi-check 同一塊區域：白箱子的背光面。
    // readRenderTargetPixels 的原點在左下，畫布座標在左上 —— 要翻。
    const x = Math.round(canvas.width * 0.46);
    const w = Math.round(canvas.width * 0.08);
    const h = Math.round(canvas.height * 0.08);
    const yTop = Math.round(canvas.height * 0.47);
    const y = canvas.height - yTop - h;
    return { box: api.gi.measureScreenSpace([x, y, w, h]), rect: [x, y, w, h] };
  });

  const f = (v) => v.toFixed(4);
  console.log(`  半徑 ${radius}，量的區域 [${out.rect.join(', ')}]`);
  console.log(`  收集到：R ${f(out.box.r)}  G ${f(out.box.g)}  B ${f(out.box.b)}`);
  console.log(`  每幀成本 ${out.box.perFrameMs.toFixed(2)} ms（法線重畫 + 收集，半解析度）`);

  check(out.box.r > 0.002, 'SSGI 真的收集到光了', `R ${f(out.box.r)}`);
  check(out.box.perFrameMs < 8, '每幀成本在合理範圍', `${out.box.perFrameMs.toFixed(2)} ms`);
  // 真正的判準：紅比藍多。白箱子＋白光的話 R 與 B 應該一樣。
  check(
    out.box.r > out.box.b * 1.5,
    '收集到的光偏紅 —— 那個紅只可能是紅地板反彈來的',
    `R/B = ${(out.box.r / Math.max(out.box.b, 1e-9)).toFixed(2)}`,
  );
  check(errors.length === 0, '沒有主控台錯誤', errors.slice(0, 2).join(' | ') || undefined);
} catch (e) {
  fail('關卡跑到一半就掛了', String(e).split('\n')[0].slice(0, 140));
}

await page.close();
await browser.close();
site.close();
finish('螢幕空間間接光');
