/**
 * 間接光的關卡：證明背光面的光**是從紅牆反彈過來的**，兩個後端都要。
 *
 * ## 為什麼判準是顏色而不是亮度
 *
 * 「有沒有變亮」是最容易造假的訊號 —— 多留一盞環境光、係數乘錯、色調對應
 * 換一個，畫面都會變亮，而變亮很容易被讀成「間接光生效了」。
 *
 * 所以場景是刻意設計的：紅牆紅地板、**白**箱子、一盞方向光、沒有環境光、
 * 沒有 env map，而且場景裡**只有這一組東西**。箱子的背光面拿不到任何直接光。
 *
 * 於是那一面上出現的紅色只有一個來源：從紅牆反彈上來的光。判準是
 * **紅比藍高多少**，而那個訊號：
 *
 * | 造假的方式 | 會發生什麼 |
 * | --- | --- |
 * | 偷偷加一盞白色環境光 | 紅藍一起上去，比值不動 |
 * | SH 係數算錯 | 整面不亮 |
 * | 把強度調大 | 關掉那一輪也會跟著亮，A/B 沒有差 |
 *
 * ## 兩個後端關掉的方式不同，而那是量出來的不是選的
 *
 * | | 怎麼關 | 為什麼 |
 * | --- | --- | --- |
 * | WebGL | 執行期改 uniform | uniform 每幀都會上傳，改了立刻生效 |
 * | WebGPU | **開兩次頁面** | 那條路的強度是編譯期常數，改不動 |
 *
 * 第二列是實測的：把它做成 TSL 的 `uniform()` 之後，JS 這一側讀回來都對
 * （0 / 1 / 50），但畫面**一個位元都沒動** —— 連把體積原點搬到 9999 都沒有
 * 反應，而同一輪裡改 `scene.background` 是立刻生效的。所以畫面是新的，是
 * 那一段的 uniform 沒有被重新上傳（它掛在 lighting context 底下）。
 *
 * 兩種做法都是「同一個場景、同一組相機、同一份著色器，只有強度不同」，所以
 * 問到的是同一件事。
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
  const file = path.startsWith('/cooked')
    ? join(COOKED, path)
    : join(DIST, path === '/' ? 'index.html' : path);
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

console.log('間接光：背光面上的紅色是不是反彈來的');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 800, height: 480 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().split('\n')[0]);
});
page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e.message).split('\n')[0]));

let failed = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) failed++;
};
const f = (v) => v.toFixed(1);

/**
 * 載入一頁、烘完探針、量背光面。
 *
 * @param toggle 這條路能不能在執行期開關（WebGL 能，WebGPU 不能）。
 */
async function run(url, handle, toggle) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(
    (h) => window[h] !== undefined && window[h].gi !== null && window[h].gi !== undefined,
    handle,
    { timeout: 120000 },
  );

  return page.evaluate(
    async ([h, canToggle]) => {
      const api = window[h];
      const gi = api.gi;

      // 烘完為止。分幀烘，所以要一直呼叫。
      let rounds = 0;
      while (gi.stats().baked < gi.stats().probes && rounds < 2000) {
        await gi.bake();
        rounds++;
      }

      // 這個框要**完全落在白箱子的背光面上**。第一版往下多掃到幾十行紅
      // 地板，於是「關掉」那一輪就已經有 R−B = 25.3，判準被稀釋掉了。
      const canvas = api.renderer.domElement;
      const rect = [
        Math.round(canvas.width * 0.46),
        Math.round(canvas.height * 0.47),
        Math.round(canvas.width * 0.08),
        Math.round(canvas.height * 0.08),
      ];

      const draw = async () => {
        await api.step(0);
        return gi.sample(rect[0], rect[1], rect[2], rect[3]);
      };

      // CPU 那份公式在同一點求值 —— 分得出「烘的不一樣」還是「著色的不一樣」。
      const cpu = gi.sampleCpu([-5, 14, -5], [-0.707, 0, -0.707]);

      let off = null;
      if (canToggle) {
        await gi.setEnabled(false);
        off = await draw();
        await gi.setEnabled(true);
      }
      const on = await draw();
      return { off, on, stats: gi.stats(), rounds, rect, cpu };
    },
    [handle, toggle],
  );
}

/** 對一組量測結果跑判準。`off` 來自同一頁（WebGL）或另一頁（WebGPU）。 */
function judge(label, out, off) {
  const on = out.on;
  const { stats } = out;
  console.log(`\n── ${label}`);
  console.log(
    `  探針 ${stats.baked}/${stats.probes}，接了 ${stats.materials} 個材質，烘了 ${out.rounds} 輪`,
  );
  console.log(`  CPU 求值（同一點同一法線）：${out.cpu.map((v) => v.toFixed(3)).join(', ')}`);
  console.log(`  關：R ${f(off.r)}  G ${f(off.g)}  B ${f(off.b)}`);
  console.log(`  開：R ${f(on.r)}  G ${f(on.g)}  B ${f(on.b)}`);

  // ## 先證明「量的地方是對的」
  //
  // 白箱子的背光面在關掉間接光時應該是**純黑**：那一面拿不到任何直接光。
  // 不是黑的就代表這個框掃到紅地板或紅牆了，而那會把後面每一條都稀釋掉。
  check(
    off.r < 3 && off.g < 3 && off.b < 3,
    '量的地方是白箱子的背光面（關掉時是黑的）',
    `關掉時 R ${f(off.r)}`,
  );

  check(stats.baked === stats.probes, '探針全部烘完', `${stats.baked}/${stats.probes}`);
  check(stats.materials > 0, '有材質接上間接光', `${stats.materials} 個`);
  check(on.r > off.r + 10, '背光面亮起來了', `R ${f(off.r)} → ${f(on.r)}`);

  // ## 真正的判準：紅比藍高
  //
  // 白箱子 + 白光的話 R 與 B 應該一樣。紅色只能來自紅牆的反彈。
  const gap = on.r - on.b;
  check(gap > 20, '背光面偏紅 —— 那個紅只可能是牆反彈來的', `R−B = ${f(gap)}`);

  // 烘出來的係數本身也要是紅的。這一條分得出「烘對了但著色錯」與「烘就錯了」。
  const [cr, cg] = out.cpu;
  check(
    cr > cg * 5,
    '烘出來的係數本身就是紅的',
    `CPU R/G = ${(cr / Math.max(cg, 1e-9)).toFixed(1)}`,
  );
  return gap;
}

/**
 * 烘完之後把那塊藍板子搬到箱子旁邊，重烘過期的探針，再量一次。
 */
async function runDynamic(url, handle) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(
    (h) => window[h] !== undefined && window[h].gi !== null && window[h].gi !== undefined,
    handle,
    { timeout: 120000 },
  );
  return page.evaluate(async (h) => {
    const api = window[h];
    const gi = api.gi;
    let rounds = 0;
    while (gi.stats().baked < gi.stats().probes && rounds < 2000) {
      await gi.bake();
      rounds++;
    }

    // ## 這一段量的是**探針資料**，不是畫面像素
    //
    // 第一版量畫面，而把板子搬到箱子旁邊之後它剛好擋在相機與箱子中間 ——
    // 量到的那塊像素變成板子本身（紅色從 94.8 崩到 3.3）。那個數字看起來
    // 像「間接光壞了」，其實是**量錯地方**：框裡的東西換人了。
    //
    // 問「附近的探針有沒有記到那塊藍板子」的話，直接問探針就好，而且它
    // 完全不受遮擋影響。`sampleCpu` 用的是與 shader 逐字相同的公式。
    const faceNormal = [-0.707, 0, -0.707];
    const faceAt = [-5, 14, -5];
    const before = gi.sampleCpu(faceAt, faceNormal);

    // 搬到箱子旁邊（箱子在 0,14,0）。
    const marked = gi.moveBlocker(-9, 12, -9);
    const rebaked = await gi.bakeStale();
    await api.step(0);
    const after = gi.sampleCpu(faceAt, faceNormal);
    return { before, after, marked, rebaked };
  }, handle);
}

const base = `http://localhost:${server.address().port}`;
try {
  // WebGL：同一頁裡改 uniform 就能關。
  const webgl = await run(`${base}/?gi=1`, '__ww', true);
  const glGap = judge('WebGL（onBeforeCompile 注入 GLSL）', webgl, webgl.off);

  // ## WebGPU 那條路一定要一起驗
  //
  // `onBeforeCompile` 是 WebGL 的鉤子，`WebGPURenderer` 完全不經過它。只驗
  // 一邊的症狀是另一邊靜靜地沒有間接光 —— 這個專案在 VAT 上踩過一樣的坑。
  const gpuOff = await run(`${base}/webgpu.html?gi=1&giOff=1`, '__wwgpu', false);
  const gpuOn = await run(`${base}/webgpu.html?gi=1`, '__wwgpu', false);
  const gpuGap = judge('WebGPU（IrradianceNode + TSL）', gpuOn, gpuOff.on);

  // ## 會動的東西：搬一塊藍板子過去，箱子那一面要變藍
  //
  // ADR-0006 原本寫的限制是「會動的東西不反彈光」。重烘附近的探針之後
  // 它應該反彈得了 —— 而驗它的方式與整支檔案同一個邏輯：**顏色**。
  //
  // 場景裡除了那塊板子沒有任何藍色，所以藍色是個只有它做得出來的訊號。
  // 用亮度的話搬一塊亮的東西過去本來就會變亮，證明不了是間接光。
  const dynamic = await runDynamic(`${base}/?gi=1`, '__ww');
  console.log('\n── 會動的東西（重烘附近的探針）');
  console.log(`  搬過去標了 ${dynamic.marked} 顆過期，重烘了 ${dynamic.rebaked} 顆`);
  const g = (v) => v.map((n) => n.toFixed(4)).join(', ');
  console.log(`  箱子那一面的輻照度（探針算的）搬之前：${g(dynamic.before)}`);
  console.log(`                搬之後：${g(dynamic.after)}`);

  check(dynamic.marked > 0, '搬動有標到探針', `${dynamic.marked} 顆`);
  check(dynamic.rebaked > 0, '過期的探針真的被重烘了', `${dynamic.rebaked} 顆`);

  // 藍色在這個場景裡只可能來自那塊板子的反彈。
  const blueBefore = dynamic.before[2];
  const blueAfter = dynamic.after[2];
  check(
    blueAfter > blueBefore * 1.5,
    '附近的探針記到了那塊藍板子',
    `藍 ${blueBefore.toFixed(4)} → ${blueAfter.toFixed(4)}`,
  );

  // 而且藍要漲得比紅多 —— 不然只是「附近多了一個東西所以整體變亮」。
  const blueGain = blueAfter - blueBefore;
  const redGain = dynamic.after[0] - dynamic.before[0];
  check(
    blueGain > redGain,
    '藍漲得比紅多，不是整體變亮',
    `Δ藍 ${blueGain.toFixed(4)} vs Δ紅 ${redGain.toFixed(4)}`,
  );

  console.log('');
  // ## 兩條路的**絕對值**也要對得上
  //
  // 這裡原本只問「兩邊都大於 20」，而註解宣稱兩邊差兩倍是「這個模組管不到
  // 的渲染器差異」。那個解釋沒有量過，而它讓那個兩倍在畫面上印了很久卻
  // 沒有人再看（doctrine 8 與 21）。
  //
  // 真正的原因是 WebGL 那條注入把 Three 片段著色器裡的 `normal` 直接餵進
  // 世界空間的 SH —— 而那個 `normal` 是**視空間**的。也就是間接光會跟著
  // 相機轉。node 那份用的是 `normalWorld`，一直是對的。
  //
  // 修好之後兩邊差 0.9%（124.8 對 123.7）。剩下的是烘的時候各自把場景拍成
  // cubemap 的差異，光柵化規則本來就不同。
  check(
    glGap > 20 && gpuGap > 20,
    '兩個後端都有間接光',
    `WebGL R−B ${f(glGap)}，WebGPU R−B ${f(gpuGap)}`,
  );
  const gapRatio = Math.max(glGap, gpuGap) / Math.max(Math.min(glGap, gpuGap), 1e-6);
  check(gapRatio < 1.1, '而且兩邊的量級一致 —— 不是一邊亮一倍', `比值 ${gapRatio.toFixed(3)}`);

  check(errors.length === 0, '沒有主控台錯誤', errors.slice(0, 2).join(' | ') || undefined);
} catch (e) {
  console.log('  ✗ 失敗：' + String(e).split('\n')[0].slice(0, 140));
  failed++;
}

await page.close();
await browser.close();
server.close();

if (failed > 0) {
  console.log(`\n間接光關卡：${failed} 項沒過`);
  process.exit(1);
}
console.log('\n間接光關卡：全過');
