/**
 * 幀是被 CPU 綁住還是被 GPU 綁住 —— 這決定 GPU 驅動繪製值不值得。
 *
 * GPU 驅動繪製要做的事是把剔除搬到 GPU 上。它能省的**上限**就是 CPU 那一段
 * ——而 CPU 與 GPU 是平行跑的，所以如果幀時間本來就等於 GPU 時間，那 CPU
 * 那一段是**藏在後面的**，搬走它一毫秒都省不到，反而多給已經是瓶頸的那一側
 * 加工作。
 *
 * 這不是代理量測（impostor 那次的錯是拿一個構不到的東西去逼近）。這裡量的
 * 是**上限本身**：省不到比 CPU 更多的時間，而 CPU 有多少是直接量得到的。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
import { listenSafe } from '../lib/listen-safe.mjs';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = join(root, 'apps/example/dist');
const COOKED = join(root, 'apps/benchmark/public');
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (path === '/favicon.ico') { res.writeHead(204).end(); return; }
  const file = path.startsWith('/cooked') ? join(COOKED, path) : join(DIST, path === '/' ? 'index.html' : path);
  readFile(file).then(
    (b) => { res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' }[extname(file)] ?? 'application/octet-stream' }); res.end(b); },
    () => res.writeHead(404).end(),
  );
});
await listenSafe(server);

const SCENES = [
  ['遠景・兩萬個', 'count=20000&spread=900&orbit=520'],
  ['遠景・六萬個', 'count=60000&spread=900&orbit=520'],
  ['貼地・六萬個', 'count=60000&spread=700&orbit=90'],
];

console.log('幀被誰綁住：CPU 那一段搬得走的話，最多省多少\n');
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const base = `http://localhost:${server.address().port}`;

try {
  for (const [label, query] of SCENES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultNavigationTimeout(240000);
    await page.goto(`${base}/?${query}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ww?.totalFrames > 60, undefined, { timeout: 240000 });

    const out = await page.evaluate(async () => {
      await window.__ww.settleHlod();

      // ## 幀時間要用 rAF 量，而且要在停掉迴圈之前
      //
      // 試過兩種都不行：
      //
      // - 直接量 `step()` 的耗時 —— 那只是**送指令**，不等 GPU 畫完。
      //   實測 0.5 ms，而同一個場景的 GPU 是 10 ms。
      // - 加 `gl.finish()` —— Chrome 的命令緩衝下它不是真的同步，數字沒動。
      //
      // rAF 量到的是**真的被呈現**的幀，那才是使用者感覺到的東西。代價是它
      // 被垂直同步夾住（約 16.7 ms），所以只有在 GPU 超過那條線的場景裡
      // 才看得出「誰綁住了幀」。
      const frames = await new Promise((resolve) => {
        const deltas = [];
        let last = performance.now();
        let n = 0;
        const tick = () => {
          const now = performance.now();
          deltas.push(now - last);
          last = now;
          if (++n < 90) requestAnimationFrame(tick);
          else resolve(deltas);
        };
        requestAnimationFrame(tick);
      });
      frames.sort((a, b) => a - b);

      const gpu = await window.__ww.measureGpuMs(0, 1200, 15);

      const cpu = [];
      for (let i = 0; i < 40; i++) {
        window.__ww.step(0);
        cpu.push(window.__ww.rocks.stats.cpuMs);
      }
      cpu.sort((a, b) => a - b);

      return {
        gpu: gpu.p50,
        frame: +frames[frames.length >> 1].toFixed(3),
        cpu: +cpu[cpu.length >> 1].toFixed(3),
      };
    });
    await page.close();

    const ceiling = (out.cpu / out.frame) * 100;
    console.log(`  ${label}`);
    console.log(`    幀 ${out.frame} ms  GPU ${out.gpu} ms  剔除的 CPU ${out.cpu} ms`);
    console.log(`    **GPU 驅動繪製的上限：${ceiling.toFixed(1)}% 的幀時間**\n`);
  }
} catch (e) {
  console.log('失敗：' + String(e).split('\n')[0].slice(0, 160));
  process.exitCode = 1;
}
await browser.close();
server.close();
