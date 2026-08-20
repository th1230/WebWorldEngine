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
 * VAT 已經各有兩份，而它們原本只驗「WebGPU 那邊有在動」，沒有驗「兩邊一樣」。
 *
 * 這一道就是那個缺口：同一個場景、同一組參數，兩個後端各跑一次，比數字。
 *
 * ## 每個效果只要往 `EFFECTS` 加一列
 *
 * 量測函式**兩邊共用同一支**。各寫一份的話量到的差異裡混著「量法不同」，
 * 而那分不開。
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

/**
 * 每個效果一列。
 *
 * - `key`：`window.__ww` / `window.__wwgpu` 底下的名字。
 * - `measure`：在頁面裡跑，回傳一個**數字陣列**。兩邊共用同一支。
 * - `pair`：WebGL 的第 i 個量對應 WebGPU 的第幾個。cube 那種面被對調的才要。
 * - `floor`：小於這個絕對值的差就當成 0。**可以給一個陣列**，每個量各自一個。
 *
 *   同一個陣列裡混著不同尺度的量時，單一個 floor 會把小尺度那些整個吃掉。
 *   實測踩過：接觸陰影的取樣值是 0..1 的 8 位元量（floor 用 1/255 合理），
 *   而「整張暗的比例」有意義的差異只有千分之幾 —— 於是 0.00524 對 0.00596
 *   （差 13.7%）被報成 0.000%，而那個差正是一個 4 倍的實作改動造成的。
 */
const EFFECTS = [
  {
    name: '天空（大氣散射）',
    key: 'sky',
    glUrl: '/?sky=1&verify=1',
    gpuUrl: '/webgpu.html?sky=1',
    labels: ['+X R', '+X G', '+X B', '−X R', '−X G', '−X B', '+Y R', '+Y G', '+Y B', '−Y R', '−Y G', '−Y B', '+Z R', '+Z G', '+Z B', '−Z R', '−Z G', '−Z B'],
    /**
     * cube 的 X 面在兩個後端是對調的。
     *
     * 那不是 bug，是 Three 的約定差異 —— 套件的 `projectCubeToSH` 早就有一個
     * `flip` 參數（WebGL −1、WebGPU +1）在處理它。所以 0–2 對到 3–5、
     * 3–5 對到 0–2，其餘照舊。
     */
    pair: [3, 4, 5, 0, 1, 2, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
    /** 朝下那一面是 2e-5 等級，相對差在那裡沒有意義。 */
    floor: 1e-5,
    measure: async (api) => {
      // 太陽固定在同一個高度角 —— 兩邊比的必須是同一個天空。
      api.setSun(0.6);
      const out = [];
      for (let f = 0; f < 6; f++) out.push(...(await api.sampleFaceAsync(f)));
      return out;
    },
  },
  {
    name: '接觸陰影',
    key: 'contact',
    glUrl: '/?contact=1&verify=1',
    gpuUrl: '/webgpu.html?contact=1',
    labels: ['接縫處', '空地', '受光面', '明暗交界', '物體下方', '整張暗的比例'],
    // 前五個是 0..1 的 8 位元取樣，最後一個是「整張暗的比例」——
    // 那個量的有意義差異小兩個數量級，不能共用同一個 floor。
    floor: [1 / 255, 1 / 255, 1 / 255, 1 / 255, 1 / 255, 1e-4],
    /**
     * 讀一小塊的平均，不是單一個像素。
     *
     * 接觸陰影的斑塊只佔畫面 0.5%，而取樣點就在它的邊緣上 —— 差一個像素
     * 就是 0.10 與 1.00 的差別。那量的是「邊緣剛好落在哪」，不是「效果對不對」。
     * 天空那邊改成整面平均是同一個理由。
     */
    measure: async (api) => {
      api.render();
      const out = [];
      for (const which of ['contact', 'open', 'lit', 'terminator', 'under']) {
        out.push(await api.sampleWindowAsync(which, 9));
      }
      // 整張遮罩有多少比例是暗的 —— 一個與取樣位置完全無關的量。
      out.push(await api.coverageAsync());
      return out;
    },
  },
  {
    name: '間接光探針的 SH 係數',
    key: 'gi',
    glUrl: '/?gi=1&verify=1',
    gpuUrl: '/webgpu.html?gi=1',
    labels: ['朝 −x−z', '朝 +x+z', '朝上', '朝下'],
    floor: 0.005,
    /**
     * ## 這一項的容差比別的鬆，而那是有理由的
     *
     * 別的效果比的是**同一份輸入**上的計算，所以可以要求 0.5%。這一項比的是
     * 兩邊各自**把場景拍成 cubemap** 再投影 —— 光柵化規則與材質實作本來就有
     * 差異，逐位元相同做不到。實測是 0.6–5.5%。
     *
     * 但它仍然抓得到真正的錯：cube target 的型別設錯時，方向性整個被抹平
     * （兩個相反的法線 0.626 對 0.636），那是 120% 的差。
     */
    tolerance: 0.1,
    measure: async (api) => {
      let rounds = 0;
      while (api.stats().baked < api.stats().probes && rounds < 2000) {
        await api.bake();
        rounds++;
      }
      const points = [
        [[-5, 14, -5], [-0.707, 0, -0.707]],
        [[-5, 14, -5], [0.707, 0, 0.707]],
        [[-5, 14, -5], [0, 1, 0]],
        [[-5, 14, -5], [0, -1, 0]],
      ];
      // 只看紅通道 —— 那個場景裡紅牆是唯一的間接光來源，訊號全在那裡。
      return points.map(([p, n]) => api.sampleCpu(p, n)[0]);
    },
  },
];

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const base = `http://localhost:${server.address().port}`;

/**
 * 兩個數字差多少 —— 相對差，但很小的值改看絕對差。
 *
 * ## 為什麼要兩個判準
 *
 * 幾乎全黑的通道（例如天空朝下那一面，2e-5 等級）的**相對**差沒有意義：
 * 分母太小，半精度的最後一個位元就是好幾個百分點。
 *
 * 全部用相對的話門檻就被那種值綁架：實測有意義的那幾個是 0.00%，而那一面是
 * 0.03%，於是門檻只能放到 2% —— 而 2% 藏得住「TSL 那份的光線步數從 8 改成
 * 6」（實測 1.63%）。**訂得下的門檻，就藏得住東西。**
 */
const difference = (a, b, floor) => {
  const absolute = Math.abs(a - b);
  if (absolute < floor) return 0;
  return absolute / Math.max(Math.abs(a), 1e-6);
};

const readEffect = async (url, handleName, key, measure) => {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.setDefaultNavigationTimeout(240000);
  await page.goto(url, { waitUntil: 'load' });
  try {
    await page.waitForFunction(
      (a) => window[a.handleName]?.[a.key] != null,
      { handleName, key },
      { timeout: 120000 },
    );
  } catch {
    const why = errors.length > 0 ? errors[0].slice(0, 300) : '（頁面沒有丟出任何錯誤）';
    await page.close();
    throw new Error(`${url} 沒有建起來：${why}`);
  }
  // 量測函式直接交給 Playwright 序列化過去 —— 兩邊跑的是同一份原始碼。
  const values = await page.evaluate(
    async (a) => {
      const api = window[a.handleName][a.key];
      const fn = new Function('return ' + a.source)();
      return fn(api);
    },
    { handleName, key, source: measure.toString() },
  );
  await page.close();
  return { values, errors };
};

try {
  for (const effect of EFFECTS) {
    console.log(`\n  ── ${effect.name} ──`);
    const gl = await readEffect(`${base}${effect.glUrl}`, '__ww', effect.key, effect.measure);
    const gpu = await readEffect(`${base}${effect.gpuUrl}`, '__wwgpu', effect.key, effect.measure);

    check(
      gl.errors.length === 0 && gpu.errors.length === 0,
      `兩邊都沒有主控台錯誤 —— ${(gl.errors[0] ?? gpu.errors[0])?.slice(0, 120) ?? '乾淨'}`,
    );

    const pair = effect.pair ?? gl.values.map((_, i) => i);
    // ## 兩邊都真的算出東西了
    //
    // 兩邊一起全 0 的話下面每一條比對都會過 —— 那是這一類關卡最容易有的假綠。
    const smallestFloor = Array.isArray(effect.floor) ? Math.min(...effect.floor) : effect.floor;
    const spread = (v) => Math.max(...v) - Math.min(...v);
    console.log(`  值域：WebGL ${spread(gl.values).toFixed(4)}、WebGPU ${spread(gpu.values).toFixed(4)}`);
    check(
      spread(gl.values) > smallestFloor * 10 && spread(gpu.values) > smallestFloor * 10,
      '兩邊量到的東西都有變化（不是兩邊一起是常數）',
    );

    let maxDiff = 0;
    let where = '';
    for (let i = 0; i < gl.values.length; i++) {
      const floor = Array.isArray(effect.floor) ? effect.floor[i] : effect.floor;
      const d = difference(gl.values[i], gpu.values[pair[i]], floor);
      if (d > maxDiff) {
        maxDiff = d;
        where = effect.labels?.[i] ?? String(i);
      }
      if (effect.labels !== undefined && effect.labels.length <= 6) {
        console.log(`  ${effect.labels[i].padEnd(10)} WebGL ${gl.values[i].toFixed(5)}  WebGPU ${gpu.values[pair[i]].toFixed(5)}  差 ${(d * 100).toFixed(3)}%`);
      }
    }
    // 實測一致度是 0.00%（逐位元相同），所以 0.5% 仍然是很寬的門檻。
    // 訂寬一點是為了別台機器的驅動差異，不是為了容忍實作不同。
    check(maxDiff < (effect.tolerance ?? 0.005), `兩邊一致 —— 最大差 ${(maxDiff * 100).toFixed(3)}%${maxDiff > 0 ? `（在 ${where}）` : ''}`);

    if (effect.pair !== undefined) {
      // 正面驗那個對調確實存在：不對調的話差很多。
      let naive = 0;
      for (let i = 0; i < gl.values.length; i++) {
          const floor = Array.isArray(effect.floor) ? effect.floor[i] : effect.floor;
        naive = Math.max(naive, difference(gl.values[i], gpu.values[i], floor));
      }
      check(
        naive > 0.2,
        `而且那個對調確實存在（不對調的話差 ${(naive * 100).toFixed(0)}%）—— 見 projectCubeToSH 的 flip`,
      );
    }
  }
} catch (error) {
  console.log('  ✗ ' + String(error?.message ?? error));
  failed++;
} finally {
  await browser.close();
  server.close();
}

console.log(failed === 0 ? '\n跨後端關卡：全過\n' : `\n有 ${failed} 項沒過\n`);
process.exit(failed === 0 ? 0 : 1);
