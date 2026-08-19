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

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
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
await new Promise((r) => server.listen(0, r));

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
  console.log(`  探針 ${stats.baked}/${stats.probes}，接了 ${stats.materials} 個材質，烘了 ${out.rounds} 輪`);
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
  check(cr > cg * 5, '烘出來的係數本身就是紅的', `CPU R/G = ${(cr / Math.max(cg, 1e-9)).toFixed(1)}`);
  return gap;
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

  console.log('');
  // 兩條路都要得到「明顯偏紅」。**不比絕對值**：兩個後端連烘出來的係數量級
  // 都差了兩倍多（實測 1.033 對 0.444），那是這個模組管不到的渲染器差異，
  // 而紅綠比兩邊是一致的（24.6 對 22.2）—— 那才是這裡要問的。
  check(glGap > 20 && gpuGap > 20, '兩個後端都有間接光', `WebGL R−B ${f(glGap)}，WebGPU R−B ${f(gpuGap)}`);

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
