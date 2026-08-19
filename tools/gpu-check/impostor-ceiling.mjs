/**
 * Impostor 值不值得做：先問「幾何還剩多少可以省」。
 *
 * roadmap 的 LOD 那一節自己寫過「極遠處真正該用的是 impostor 而不是 20 個
 * 三角形的爛網格」。那句話一直放在那裡沒有被檢驗過，而 doctrine 第 5 條說
 * 先量再做 —— 這條軸尤其該量，因為遮蔽剔除剛剛才示範過「上限是真的、但
 * 拿不到」。
 *
 * ## 怎麼問
 *
 * Impostor 是把一個物件換成兩個三角形。它能省的**上限**是「把幾何壓到近乎
 * 零之後，GPU 時間會少多少」。
 *
 * 而那個上限可以不寫 impostor 就量到：把 `errorPixels` 開得非常大，選階就會
 * 讓每一個 instance 都掉到最粗的那一階。那不是 impostor（最粗階還有幾十個
 * 三角形），但它是同一個方向上走得最遠的一步。
 *
 * | 量到的 | 結論 |
 * | --- | --- |
 * | 全部壓到最粗之後**快很多** | 幾何還是大頭，impostor 有空間 |
 * | 全部壓到最粗之後**差不多** | 被 fill 或繪製綁住，impostor 省不到東西 |
 *
 * 第二種的話這條軸就跟多層 HLOD 一樣：**它要省的東西這裡已經沒有了。**
 *
 * ## 這個量測會不會誇大
 *
 * 會，而且是刻意的 —— 它是上限。壓到最粗的畫面**是壞的**（誤差遠超過品質
 * 契約），所以這個數字不是「可以拿到的」，是「最多可能有這麼多」。上限很小
 * 的話就不必再往下談了。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = join(root, 'apps/example/dist');
const COOKED = join(root, 'apps/benchmark/public');
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (path === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  const file = path.startsWith('/cooked') ? join(COOKED, path) : join(DIST, path === '/' ? 'index.html' : path);
  readFile(file).then(
    (b) => {
      res.writeHead(200, {
        'content-type':
          { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' }[
            extname(file)
          ] ?? 'application/octet-stream',
      });
      res.end(b);
    },
    () => res.writeHead(404).end(),
  );
});
await new Promise((r) => server.listen(0, r));

const SCENES = [
  ['遠景・兩萬個・接長鏈', 'count=20000&spread=900&orbit=520&hlod=0&extendLod=1'],
  ['遠景・六萬個・接長鏈', 'count=60000&spread=900&orbit=520&hlod=0&extendLod=1'],
  ['貼地・六萬個・接長鏈', 'count=60000&spread=700&orbit=90&hlod=0&extendLod=1'],
];

console.log('Impostor 的上限：把幾何壓到最粗之後還能省多少\n');
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const base = `http://localhost:${server.address().port}`;

async function measure(page, query) {
  await page.goto(`${base}/?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ww?.totalFrames > 60, undefined, { timeout: 240000 });
  return page.evaluate(async () => {
    await window.__ww.settleHlod();
    const gpu = await window.__ww.measureGpuMs(0, 1200, 15);
    const info = window.__ww.renderer.info.render;
    return { gpu: gpu.p50, tri: info.triangles, calls: info.calls };
  });
}

try {
  for (const [label, query] of SCENES) {
    // **交錯**，這台機器的量測是雙峰的。
    const normal = [];
    const coarsest = [];
    for (let round = 0; round < 3; round++) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      page.setDefaultNavigationTimeout(240000);
      normal.push(await measure(page, query));
      coarsest.push(await measure(page, `${query}&errorPixels=100000`));
      await page.close();
    }
    const mid = (rows, key) => rows.map((r) => r[key]).sort((a, b) => a - b)[rows.length >> 1];
    const a = mid(normal, 'gpu');
    const b = mid(coarsest, 'gpu');
    console.log(`  ${label}`);
    console.log(
      `    正常          ${a} ms，${normal[0].tri.toLocaleString('en-US')} 個三角形，${normal[0].calls} 次繪製`,
    );
    console.log(
      `    全壓到最粗    ${b} ms，${coarsest[0].tri.toLocaleString('en-US')} 個三角形，${coarsest[0].calls} 次繪製`,
    );
    console.log(`    **幾何那一側最多還有 ${(((a - b) / a) * 100).toFixed(1)}%**\n`);
  }
} catch (e) {
  console.log('失敗：' + String(e).split('\n')[0].slice(0, 160));
  process.exitCode = 1;
}
await browser.close();
server.close();
