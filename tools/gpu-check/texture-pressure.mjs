/**
 * 貼圖資料超過 VRAM 的時候，**今天**會怎樣。
 *
 * 這不是虛擬貼圖，是虛擬貼圖那條軸的第一步。roadmap 上寫的順序是：
 *
 * 1. 先有一份貼圖資料明顯超過 VRAM 的內容
 * 2. **量「現在會怎樣」** ← 這一支
 * 3. 有了那個數字才知道要做到哪一步
 *
 * 沒有第 2 步的話，虛擬貼圖做完也不知道它省了什麼 —— 而那正是遮蔽剔除的
 * 教訓：上限是真的，拿不拿得到是另一回事。
 *
 * ## 判準是「有沒有掉懸崖」，不是絕對值
 *
 * 貼圖從 1 GB 加到 2 GB 如果只是線性變慢，那代表驅動換頁換得還可以，虛擬
 * 貼圖能省的有限。如果某一格開始**急遽變差或直接掛掉**，那就是它要解的問題，
 * 而懸崖的位置就是門檻。
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
          {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.json': 'application/json',
            '.wasm': 'application/wasm',
          }[extname(file)] ?? 'application/octet-stream',
      });
      res.end(b);
    },
    () => res.writeHead(404).end(),
  );
});
await listenSafe(server);

// 每一步大約是前一步的兩倍，一路推到掛掉為止。
const STEPS = [
  [16, 1024],
  [16, 2048],
  [16, 4096],
  [16, 8192],
  [64, 4096],
  [64, 8192],
];

console.log('貼圖壓力：每一張都不一樣，全部在畫面裡\n');
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu'],
});
const base = `http://localhost:${server.address().port}`;

for (const [count, size] of STEPS) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultNavigationTimeout(300000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).split('\n')[0].slice(0, 70)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().split('\n')[0].slice(0, 70));
  });

  try {
    await page.goto(`${base}/?textures=${count}&texSize=${size}&texStack=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ww?.totalFrames > 30, undefined, { timeout: 300000 });
    const out = await page.evaluate(async () => {
      const gpu = await window.__ww.measureGpuMs(0, 1200, 12);
      const meta = window.__ww.textureHeavy;
      const heap = performance.memory?.usedJSHeapSize ?? 0;
      return {
        gpu: gpu.p50 ?? null,
        meta: {
          textures: meta.textures,
          megabytes: meta.megabytes,
          uploaded: meta.uploaded,
          calls: meta.calls,
          triangles: meta.triangles,
        },
        heapMB: Math.round(heap / 1048576),
      };
    });
    console.log(
      `  ${String(count).padStart(4)} 張 × ${size}px = ${String(out.meta.megabytes).padStart(6)} MB  ` +
        `GPU ${out.gpu === null ? '量不到' : out.gpu + ' ms'}  ` +
        `上傳 ${out.meta.uploaded} 張  ${out.meta.calls} 次繪製  JS heap ${out.heapMB} MB` +
        (errors.length > 0 ? `  ⚠ ${errors[0]}` : ''),
    );
  } catch (e) {
    console.log(
      `  ${String(count).padStart(4)} 張 × ${size}px  **掛了**：${String(e).split('\n')[0].slice(0, 80)}`,
    );
  }
  await page.close();
}

await browser.close();
server.close();
