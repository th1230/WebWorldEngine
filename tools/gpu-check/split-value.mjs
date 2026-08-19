/**
 * 切塊工具值多少：一份大幾何 vs 切開之後的 `MultiMesh`。
 *
 * `MultiMesh` 那條軸量的是「一塊一塊生出來的地形」—— 它從來沒經過「一份大
 * 幾何」這個狀態，所以證明不了切塊工具本身有沒有用。這裡走的是使用者真正
 * 會走的那條路：先有一份完整的大幾何，再讓工具去切。
 *
 * 機位貼著地面看向遠方 —— 逐塊選階的價值全部來自「同一個東西橫跨很大的
 * 深度範圍」，從高處俯瞰會把這條軸要問的東西消掉（doctrine 第 1 條）。
 *
 * ## 時間之外一定要看畫面
 *
 * 切完之後畫面必須還是對的 —— 少畫了東西時間當然更好看。所以每一組都跟
 * 對照組逐像素比。
 *
 * **但這裡證明不了「沒有裂縫」。** 第一版數的是「本來是地面、現在變成背景」
 * 的像素，然後把它叫做破洞 —— 而把鎖邊界關掉重跑，那個數字**還是 0**。
 * 原因很簡單：起伏的地面裂開之後，縫裡露出來的是**後面那一塊地面**，不是
 * 背景。這個場景裡它根本不會變暗。
 *
 * 真正擋住裂縫的是單元測試「鎖邊界之後，邊界上的頂點在每一階都還在」
 * （packages/three/src/split.test.ts）—— 那一條在關掉鎖邊界時會紅。結構上
 * 檢查頂點在不在，比看畫面可靠得多。
 *
 * 這裡的畫面差異只回答一件事：**選階有沒有守住品質契約**（誤差投影到螢幕上
 * 不超過 errorPixels）。鎖著邊界是 0.02–0.04%，關掉之後 0.07–0.22%。
 *
 * ## 塊數之間不要排名
 *
 * 對照組與切開之間的差距是兩三倍，那個結論穩。但 64／256／1024 之間的高低
 * **在兩次執行之間會整個翻過來**（實測 64 是 62.2% 然後 58.0%，1024 是
 * 76.9% 然後 55.6%）—— 那是這台機器的雙峰，不是塊數的效果。所以這裡只報
 * 「對照組省了多少」，不排名。
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
await listenSafe(server);

const SEGMENTS = 1200;
const CONFIGS = [
  ['整片一份幾何（對照組）', 0],
  ['切成 64 塊', 64],
  ['切成 256 塊', 256],
  ['切成 1024 塊', 1024],
];

console.log(`一份 ${SEGMENTS}x${SEGMENTS} 段的地面（約 ${((SEGMENTS * SEGMENTS * 2) / 1e6).toFixed(1)}M 三角形）\n`);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const base = `http://localhost:${server.address().port}`;
const results = [];
let failed = 0;

async function run(split) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultNavigationTimeout(300000);
  await page.goto(`${base}/?bigMesh=${SEGMENTS}&split=${split}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ww?.totalFrames > 30, undefined, { timeout: 300000 });
  const out = await page.evaluate(async () => {
    const gpu = await window.__ww.measureGpuMs(0, 1500, 20);
    const info = window.__ww.renderer.info.render;
    window.__ww.step(0);
    const canvas = window.__ww.renderer.domElement;
    const flat = document.createElement('canvas');
    flat.width = canvas.width;
    flat.height = canvas.height;
    const ctx = flat.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return {
      gpu: gpu.p50,
      calls: info.calls,
      tri: info.triangles,
      meta: window.__ww.bigMesh,
      pixels: Array.from(data),
    };
  });
  await page.close();
  return out;
}

try {
  for (const [label, split] of CONFIGS) {
    const out = await run(split);
    results.push([label, out]);

    let detail = '';
    if (results.length > 1) {
      const reference = results[0][1].pixels;
      let changed = 0;
      for (let i = 0; i < reference.length; i += 4) {
        const d = Math.max(
          Math.abs(reference[i] - out.pixels[i]),
          Math.abs(reference[i + 1] - out.pixels[i + 1]),
          Math.abs(reference[i + 2] - out.pixels[i + 2]),
        );
        if (d > 8) changed++;
      }
      const total = reference.length / 4;
      const ratio = changed / total;
      detail = `\n    與對照組的畫面差異 ${(ratio * 100).toFixed(2)}%`;
      // 品質契約是「誤差投影到螢幕上 ≤ errorPixels」，所以差異必須很小。
      // 1% 是很寬鬆的上限 —— 正常是 0.02–0.04%。
      if (ratio > 0.01) {
        detail += '　✗ 差太多，選階沒守住品質契約';
        failed++;
      }
    }

    console.log(
      `  ${label}\n    ${out.meta.pieces} 塊，GPU ${out.gpu} ms，${out.calls} 次繪製，` +
        `這一幀送出 ${out.tri.toLocaleString('en-US')} 個三角形${detail}`,
    );
  }

  const baseline = results[0][1].gpu;
  console.log('');
  for (const [label, out] of results.slice(1)) {
    console.log(`  ${label}：對整片一份省 ${(((baseline - out.gpu) / baseline) * 100).toFixed(1)}%`);
  }
} catch (e) {
  console.log('失敗：' + String(e).split('\n')[0].slice(0, 160));
  failed++;
}

await browser.close();
server.close();
if (failed > 0) process.exit(1);
