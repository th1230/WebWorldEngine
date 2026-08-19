/**
 * 遮蔽剔除**淨**賺多少：GPU 省下來的要扣掉 CPU 多花的。
 *
 * doctrine 第 9 條。材質那個旋鈕就是這樣被拿掉的 —— 它「省下」的取樣時間
 * 比它自己花掉的少。
 *
 * GPU 與 CPU 是**平行**跑的，所以「GPU 省 60%」不等於「幀時間快 60%」：
 * 本來就被 CPU 綁住的內容，開了只會更慢。這裡兩個都量。
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
  ['貼地看出去・六萬個', 'count=60000&spread=700&orbit=90'],
  ['稀疏・六百個', 'count=600&spread=1400&orbit=520'],
];

console.log('遮蔽剔除：GPU 省下的，扣掉 CPU 多花的\n');
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const base = `http://localhost:${server.address().port}`;

/** 開一頁量 GPU 與 CPU。 */
async function measure(page, query) {
  await page.goto(`${base}/?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ww?.totalFrames > 60, undefined, { timeout: 180000 });
  return page.evaluate(async () => {
    await window.__ww.settleHlod();
    const gpu = await window.__ww.measureGpuMs(0, 1200, 15);
    // CPU 是逐幀量的，多跑幾幀取中位數。
    const cpu = [];
    for (let i = 0; i < 40; i++) {
      window.__ww.step(0);
      cpu.push(window.__ww.rocks.stats.cpuMs);
    }
    cpu.sort((a, b) => a - b);
    const s = window.__ww.rocks.stats;
    return {
      gpu: gpu.p50,
      cpu: +cpu[cpu.length >> 1].toFixed(3),
      occlusionMs: +s.cpuParts.occlusion.toFixed(3),
      visible: s.visible,
      occluded: s.occluded,
    };
  });
}

try {
  for (const [label, query] of SCENES) {
    console.log(`  ${label}`);
    // **交錯**：這台機器的量測是雙峰的，連續跑完一組再跑另一組會拿不同母體在比。
    const rows = [];
    for (let round = 0; round < 3; round++) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      page.setDefaultNavigationTimeout(180000);
      const off = await measure(page, query);
      const on = await measure(page, `${query}&occlusion=1`);
      await page.close();
      rows.push([off, on]);
      console.log(`    第 ${round + 1} 輪  關 GPU ${off.gpu} / CPU ${off.cpu}  開 GPU ${on.gpu} / CPU ${on.cpu}`);
    }
    const mid = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const offGpu = mid(rows.map((r) => r[0].gpu));
    const onGpu = mid(rows.map((r) => r[1].gpu));
    const offCpu = mid(rows.map((r) => r[0].cpu));
    const onCpu = mid(rows.map((r) => r[1].cpu));
    const last = rows[rows.length - 1][1];
    console.log(`    剔掉 ${last.occluded.toLocaleString('en-US')} 個，剩 ${last.visible.toLocaleString('en-US')} 個，遮蔽本身花 ${last.occlusionMs} ms`);
    console.log(`    GPU ${offGpu} → ${onGpu} ms（省 ${(offGpu - onGpu).toFixed(2)}）`);
    console.log(`    CPU ${offCpu} → ${onCpu} ms（多 ${(onCpu - offCpu).toFixed(2)}）`);
    const net = (offGpu - onGpu) - (onCpu - offCpu);
    console.log(`    **淨 ${net >= 0 ? '賺' : '賠'} ${Math.abs(net).toFixed(2)} ms**\n`);
  }
} catch (e) {
  console.log('失敗：' + String(e).split('\n')[0].slice(0, 160));
  process.exitCode = 1;
}
await browser.close();
server.close();
