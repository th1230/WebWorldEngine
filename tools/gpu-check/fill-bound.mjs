import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

/**
 * 這些內容是被 fragment 綁住，還是被幾何綁住？
 *
 * ## 這不是 gate，是一次性的探針
 *
 * 準則第八條說「每一個報出來的指標都要有一條會讓它失敗的線」。這支沒有線
 * ——它量的不是「有沒有退步」，是「接下來該做什麼」。所以它不進
 * `verify:all`，跑完之後結論寫進 roadmap，數字本身不需要每次重跑。
 *
 * ## 為什麼這個問題決定剩下的優先順序
 *
 * W6 剩下的三條軸（叢集 LOD、大地表、以及已經否決的遮蔽剔除）省的**全部
 * 都是幾何那一側**。如果 GPU 時間其實跟著像素數走，那它們的上限就是幾何
 * 佔的那一小塊，不管演算法多漂亮。
 *
 * Sponza 那次已經用拆解推過一次（幾何只佔 7.5%），但那是**推的**：
 * 三角形數 ÷ 天花板吞吐 + 繪製呼叫 × 固定成本。這支是直接量的。
 *
 * ## 判準
 *
 * 把畫布的邊長減半（像素數變四分之一），幾何完全不變：
 *
 * | 時間變成 | 代表 | 對剩下的軸 |
 * | --- | --- | --- |
 * | 約 1/4 | 被 fragment 綁住 | 幾何側的優化上限很低 |
 * | 幾乎不變 | 被幾何／繪製呼叫綁住 | 那些軸有得做 |
 *
 * 中間的話兩邊都有份，而斜率就是「fragment 佔多少」。
 */

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = join(root, 'apps/example/dist');

const SCENES = [
  {
    name: '近景・有貼圖（600 個大物件）',
    query: '?cooked=1&count=600&size=20&spread=400&orbit=90&hlodBudgetMB=512',
  },
  {
    name: '遠景・有貼圖（20,000 個）',
    query: '?cooked=1&count=20000&hlodBudgetMB=512',
  },
  {
    name: '遠景・純色（60,000 個，預設內容）',
    query: '?count=60000&hlodBudgetMB=512',
  },
];

async function main() {
  console.log('建置 example…');
  execFileSync('pnpm', ['--filter', '@ww/example-app', 'build'], {
    cwd: root,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  const site = await serve(DIST);
  const browser = await launch();
  try {
    for (const scene of SCENES) {
      const page = await browser.newPage();
      await page.goto(site.url + scene.query, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__ww?.totalFrames > 90, undefined, {
        timeout: 60_000,
      });
      const out = await page.evaluate(() => window.__ww.measureFillBound(6.0));
      await page.close();

      console.log(`\n${scene.name}`);
      const full = out.full;
      for (const key of ['full', 'half', 'quarter']) {
        const r = out[key];
        if (r?.ms == null) {
          console.log(`  ${key.padEnd(8)} 量不到`);
          continue;
        }
        console.log(
          `  ${key.padEnd(8)} ${String(r.pixels).padStart(9)} 像素` +
            `   ${r.ms.toFixed(3).padStart(8)} ms` +
            `   ${r.triangles.toLocaleString('en-US').padStart(11)} 個三角形` +
            `   （像素 ${(r.pixels / full.pixels).toFixed(3)}、時間 ${(r.ms / full.ms).toFixed(3)}）`,
        );
      }
      // 三角形數也要報：縮小畫布會讓選階挑得更粗，於是幾何**也**跟著變少。
      // 沒發現這件事的話，那部分的省會被算到 fragment 頭上。
      const q = out.quarter;
      if (q?.ms != null) {
        // 時間對像素的斜率：1 代表完全跟著像素走，0 代表完全不跟。
        const slope = (1 - q.ms / full.ms) / (1 - q.pixels / full.pixels);
        console.log(
          `  → 時間跟著像素走的比例約 ${(slope * 100).toFixed(0)}%` +
            `（三角形同時變成 ${(q.triangles / full.triangles).toFixed(3)} 倍）`,
        );
      }
    }
  } finally {
    await browser.close();
    site.close();
  }
}

async function serve(dir) {
  const COOKED = join(root, 'apps/benchmark/public');
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = path.startsWith('/cooked')
      ? join(COOKED, path)
      : join(dir, path === '/' ? 'index.html' : path);
    readFile(file).then(
      (bytes) => {
        const type =
          { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }[
            extname(file)
          ] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type });
        res.end(bytes);
      },
      () => res.writeHead(404).end(),
    );
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return { url: `http://localhost:${server.address().port}/`, close: () => server.close() };
}

async function launch() {
  const errors = [];
  for (const channel of ['chrome', undefined]) {
    try {
      return await chromium.launch(channel === undefined ? {} : { channel });
    } catch (error) {
      errors.push(String(error).split('\n')[0]);
    }
  }
  throw new Error(`無法啟動瀏覽器：\n  ${errors.join('\n  ')}`);
}

await main();
