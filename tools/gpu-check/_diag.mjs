import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
const root = 'D:/script_learn/WebWorldEngine';
const COOKED = join(root, 'apps/benchmark/public');
const DIST = join(root, 'apps/example/dist');
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const file = path.startsWith('/cooked') ? join(COOKED, path) : join(DIST, path === '/' ? 'index.html' : path);
  readFile(file).then((b) => {
    res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }[extname(file)] ?? 'application/octet-stream' });
    res.end(b);
  }, () => res.writeHead(404).end());
});
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ channel: 'chrome' });
const BASE = '?cooked=1&count=600&size=20&spread=400&orbit=90&hlodBudgetMB=512';
for (const q of ['&ww=0', '']) {
  const page = await browser.newPage();
  await page.goto(url + BASE + q, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ww?.totalFrames > 90, undefined, { timeout: 60000 });
  const out = await page.evaluate(() => {
    const w = window.__ww;
    w.renderer.info.reset();
    w.step(6.0);
    const i = w.renderer.info.render;
    const r = w.rocks;
    return {
      calls: i.calls, triangles: i.triangles, points: i.points,
      visible: r.visibleCount ?? null, merged: r.mergedDraws ?? null,
      levels: r.levelCounts ? Array.from(r.levelCounts) : null,
      drawRange: r._multiDrawCount ?? null,
    };
  });
  console.log((q === '&ww=0' ? 'native' : 'ww    ') + ' ' + JSON.stringify(out));
  await page.close();
}
await browser.close();
server.close();
