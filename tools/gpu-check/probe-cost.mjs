/**
 * 烘一顆探針要多少時間 —— 決定「會動的東西能不能有間接光」。
 *
 * ADR-0006 明寫了這個限制：**會動的東西不反彈光**。烘出來的探針是靜態的。
 *
 * 而在這個套件的身分底下，補這個洞的作法不是寫一套螢幕空間 GI（那是渲染器
 * 的事），是**重烘附近的探針** —— 探針怎麼烘、怎麼分預算，正是 ADR-0006 說
 * 這裡該做的那一半。
 *
 * 那條路可不可行只取決於一個數字：**一顆探針多少毫秒**。每顆探針要把場景畫
 * 六次再從 GPU 讀回 CPU，而讀回是會讓管線停下來的。
 *
 * 便宜的話（一顆遠低於一毫秒）就每幀重烘幾顆；貴的話這條路直接不通，而
 * 「不通」也要有數字撐著才寫得進文件。
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
  if (path === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  const file = join(DIST, path === '/' ? 'index.html' : path);
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
await listenSafe(server);

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
try {
  for (const face of [4, 8, 16, 32]) {
  await page.goto(`http://localhost:${server.address().port}/?gi=1&probeFace=${face}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ww?.gi !== null && window.__ww?.gi !== undefined, undefined, {
    timeout: 120000,
  });
  const out = await page.evaluate(async () => {
    const gi = window.__ww.gi;
    const started = performance.now();
    let rounds = 0;
    while (gi.stats().baked < gi.stats().probes && rounds < 5000) {
      await gi.bake();
      rounds++;
    }
    const elapsed = performance.now() - started;
    const stats = gi.stats();
    return { elapsed, rounds, probes: stats.probes };
  });
  const perProbe = out.elapsed / out.probes;

  console.log(`  面寬 ${face}：一顆 ${perProbe.toFixed(2)} ms（${out.rounds} 輪烘完 ${out.probes} 顆）`);
  }
} catch (e) {
  console.log('失敗：' + String(e).split('\n')[0].slice(0, 160));
  process.exitCode = 1;
}
await browser.close();
server.close();
