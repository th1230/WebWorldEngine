/**
 * 同一個效果，兩個後端，必須算出同一組數字。
 *
 * ## 為什麼需要這一道
 *
 * `WebGPURenderer` 不吃 `ShaderMaterial`、也不經過 `onBeforeCompile`，所以
 * 每個注入著色器的效果都要有**第二份實作**（node / TSL）。
 *
 * 兩份實作的失效方式是這個專案最怕的那一種：不報錯、幀時間正常，只是其中
 * 一邊的畫面不一樣。而「記得一起改」這種註解擋不住它 —— 套件裡的間接光與
 * VAT 已經各有兩份，而它們目前只驗「WebGPU 那邊有在動」，沒有驗「兩邊一樣」。
 *
 * 這一道就是那個缺口：同一個場景、同一組參數，兩個後端各跑一次，比數字。
 *
 * ## cube 的 X 面在兩個後端是對調的
 *
 * 那不是 bug，是 Three 的約定差異 —— 套件裡的 `projectCubeToSH` 早就有一個
 * `flip` 參數（WebGL −1、WebGPU +1）在處理它。實測也精確吻合：WebGL 的 +X
 * 與 WebGPU 的 −X 一模一樣。
 *
 * 所以這裡比對時把 0 與 1 對調，並且**正面驗那個對調成立** —— 哪天 Three
 * 把它統一了，這一道會紅，而那正是我們該知道的時候。
 *
 * ## 讀的是整面的平均，不是正中心那一格
 *
 * 64 寬的面「正中心」落在第 31 與 32 格之間。鏡像之後兩邊讀到的方向差半格，
 * 在天空的漸層上量出 2–4% 的差 —— 看起來像實作不一致，其實是量法的問題。
 * 平均不受鏡像影響。改成平均之後量到的是 **0.0%**。
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
  if (path === '/favicon.ico') { res.writeHead(204).end(); return; }
  const file = join(DIST, path === '/' ? 'index.html' : path);
  readFile(file).then(
    (b) => { res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }[extname(file)] ?? 'application/octet-stream' }); res.end(b); },
    () => res.writeHead(404).end(),
  );
});
await listenSafe(server);

console.log('跨後端：同一個效果，兩邊要算出同一組數字');
let failed = 0;
const check = (ok, message) => {
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + message);
  if (!ok) failed++;
};

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const base = `http://localhost:${server.address().port}`;

/**
 * 兩個顏色差多少 —— 相對差，但幾乎全黑的通道改看絕對差。
 *
 * ## 為什麼要兩個判準
 *
 * 朝下那一面的值是 2e-5 等級。那裡的**相對**差沒有意義（分母太小，半精度
 * 的最後一個位元就是好幾個百分點），而**絕對**差是有意義的。
 *
 * 全部用相對的話門檻就被那一面綁架：實測有意義的那幾面是 0.00%，而朝下
 * 那面是 0.03%，於是門檻只能放到 2% —— 而 2% 藏得住「TSL 那份的光線步數
 * 從 8 改成 6」（實測 1.63%）。**訂得下的門檻，就藏得住東西。**
 */
const worst = (a, b) =>
  Math.max(
    ...a.map((v, i) => {
      const absolute = Math.abs(v - b[i]);
      // 值太小就只看絕對差 —— 通過的話回 0，不去污染最大值。
      if (absolute < 1e-5) return 0;
      return absolute / Math.max(Math.abs(v), 1e-6);
    }),
  );
const show = (c) => c.map((v) => v.toFixed(5)).join(' ');

const readSky = async (url, handleName) => {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.setDefaultNavigationTimeout(240000);
  await page.goto(url, { waitUntil: 'load' });
  try {
    await page.waitForFunction((h) => window[h]?.sky != null, handleName, { timeout: 120000 });
  } catch {
    const why = errors.length > 0 ? errors[0].slice(0, 300) : '（頁面沒有丟出任何錯誤）';
    await page.close();
    throw new Error(`${url} 沒有建起來：${why}`);
  }
  const faces = await page.evaluate(async (h) => {
    const api = window[h].sky;
    // 太陽固定在同一個高度角 —— 兩邊比的必須是同一個天空。
    api.setSun(0.6);
    const out = [];
    for (let f = 0; f < 6; f++) out.push(await api.sampleFaceAsync(f));
    return out;
  }, handleName);
  await page.close();
  return { faces, errors };
};

try {
  const gl = await readSky(`${base}/?sky=1&verify=1`, '__ww');
  const gpu = await readSky(`${base}/webgpu.html?sky=1`, '__wwgpu');

  check(gl.errors.length === 0, `WebGL 那邊沒有主控台錯誤 —— ${gl.errors[0]?.slice(0, 120) ?? '乾淨'}`);
  check(gpu.errors.length === 0, `WebGPU 那邊沒有主控台錯誤 —— ${gpu.errors[0]?.slice(0, 120) ?? '乾淨'}`);

  // ## 天空真的畫出來了
  //
  // 兩邊都全黑的話下面每一條比對都會過 —— 那是這一類關卡最容易有的假綠。
  const lit = (faces) => faces.reduce((a, c) => a + c[0] + c[1] + c[2], 0);
  console.log(`  兩邊的總亮度：WebGL ${lit(gl.faces).toFixed(4)}、WebGPU ${lit(gpu.faces).toFixed(4)}`);
  check(lit(gl.faces) > 0.5 && lit(gpu.faces) > 0.5, '兩邊的天空都真的有東西（不是兩邊一起全黑）');

  // ## X 那兩面在兩個後端是對調的
  const names = ['+X', '−X', '+Y', '−Y', '+Z', '−Z'];
  /** WebGL 的第 f 面，對應 WebGPU 的第幾面。 */
  const paired = [1, 0, 2, 3, 4, 5];
  for (let f = 0; f < 6; f++) {
    const a = gl.faces[f];
    const b = gpu.faces[paired[f]];
    const diff = worst(a, b);
    console.log(`  ${names[f]}  WebGL ${show(a)}  |  WebGPU(${names[paired[f]]}) ${show(b)}  |  差 ${(diff * 100).toFixed(3)}%`);
  }

  let maxDiff = 0;
  for (let f = 0; f < 6; f++) maxDiff = Math.max(maxDiff, worst(gl.faces[f], gpu.faces[paired[f]]));
  // 實測一致度是 **0.00%**（逐位元相同），所以門檻訂在 0.5% 仍然是很寬的。
  // 訂寬一點是為了別台機器的驅動差異，不是為了容忍實作不同。
  check(maxDiff < 0.005, `六個面兩邊一致 —— 最大差 ${(maxDiff * 100).toFixed(3)}%`);

  // 正面驗那個對調確實存在：不對調的話 X 那兩面差很多。
  const naive = Math.max(worst(gl.faces[0], gpu.faces[0]), worst(gl.faces[1], gpu.faces[1]));
  check(
    naive > 0.2,
    `而且 X 那兩面確實是對調的（不對調的話差 ${(naive * 100).toFixed(0)}%）—— 這是 Three 的 cube 約定，見 projectCubeToSH 的 flip`,
  );
} catch (error) {
  console.log('  ✗ ' + String(error?.message ?? error));
  failed++;
} finally {
  await browser.close();
  server.close();
}

console.log(failed === 0 ? '\n跨後端關卡：全過\n' : `\n有 ${failed} 項沒過\n`);
process.exit(failed === 0 ? 0 : 1);
