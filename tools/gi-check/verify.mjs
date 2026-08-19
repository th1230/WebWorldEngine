/**
 * 間接光的關卡：證明背光面的光**是從紅牆反彈過來的**。
 *
 * ## 為什麼判準是顏色而不是亮度
 *
 * 「有沒有變亮」是最容易造假的訊號 —— 多留一盞環境光、係數乘錯、色調對應
 * 換一個，畫面都會變亮，而變亮很容易被讀成「間接光生效了」。
 *
 * 所以場景是刻意設計的：紅牆紅地板、**白**箱子、一盞方向光、沒有環境光、
 * 沒有 env map。箱子的背光面拿不到任何直接光。
 *
 * 於是那一面上出現的紅色只有一個來源：從紅牆反彈上來的光。判準是
 * **紅比藍高多少**，而那個訊號：
 *
 * | 造假的方式 | 會發生什麼 |
 * | --- | --- |
 * | 偷偷加一盞白色環境光 | 紅藍一起上去，比值不動 |
 * | SH 係數算錯 | 整面不亮，比值不動 |
 * | 把 intensity 調大 | 關掉那一輪也會跟著亮，A/B 沒有差 |
 *
 * ## A/B 走同一條著色器路徑
 *
 * 開關是把 `intensity` 設成 0／1，不是換材質。換材質的話比的是兩個不同的
 * 著色器，那個比較說明不了間接光。
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

try {
  await page.goto(`http://localhost:${server.address().port}/?gi=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ww?.gi !== null && window.__ww?.totalFrames > 5, undefined, {
    timeout: 120000,
  });

  const out = await page.evaluate(async () => {
    const gi = window.__ww.gi;

    // 烘完為止。分幀烘，所以要一直呼叫。
    let rounds = 0;
    while (gi.stats().baked < gi.stats().probes && rounds < 2000) {
      await gi.bake();
      rounds++;
    }

    // 量箱子背光面那一塊。相機是固定的，所以這個矩形是穩定的。
    //
    // 畫面 800×480，devicePixelRatio 可能不是 1，所以用 canvas 的實際尺寸算。
    const canvas = window.__ww.renderer.domElement;
    // 這個框要**完全落在白箱子的背光面上**。第一版往下多了幾十個像素，
    // 掃到了紅地板 —— 於是「關掉」那一輪就已經有 R−B = 25.3，而那個紅是
    // 地板的，不是反彈到箱子上的。整個判準就被那幾行像素稀釋掉了。
    const rect = [
      Math.round(canvas.width * 0.46),
      Math.round(canvas.height * 0.47),
      Math.round(canvas.width * 0.08),
      Math.round(canvas.height * 0.08),
    ];

    const read = (on) => {
      gi.setEnabled(on);
      window.__ww.step(0);
      return gi.sample(rect[0], rect[1], rect[2], rect[3]);
    };

    return { off: read(false), on: read(true), stats: gi.stats(), rounds, rect };
  });

  const { off, on, stats } = out;
  const f = (v) => v.toFixed(1);
  console.log(`  探針 ${stats.baked}/${stats.probes}，接了 ${stats.materials} 個材質，烘了 ${out.rounds} 輪`);
  console.log(`  量的區域 [${out.rect.join(', ')}]`);
  console.log(`  關：R ${f(off.r)}  G ${f(off.g)}  B ${f(off.b)}`);
  console.log(`  開：R ${f(on.r)}  G ${f(on.g)}  B ${f(on.b)}`);

  // ## 先證明「量的地方是對的」
  //
  // 白箱子在白光下的背光面，關掉間接光時應該是**接近中性的深色** ——
  // 紅綠藍差不多。差很多就代表這個框掃到紅地板或紅牆了，而那會把後面
  // 每一條判準都稀釋掉。
  //
  // 這一條是量尺自己的檢查（doctrine 第 11 條）：先確定尺量的是那個東西。
  check(Math.abs(off.r - off.b) < 6, '量的地方是白箱子，不是紅牆', `關掉時 R−B = ${f(off.r - off.b)}`);

  check(stats.baked === stats.probes, '探針全部烘完', `${stats.baked}/${stats.probes}`);
  check(stats.materials > 0, '有材質接上間接光', `${stats.materials} 個`);

  // 開了之後那一面要變亮。這是必要條件，不是充分條件。
  check(on.r > off.r + 2, '背光面變亮了', `R ${f(off.r)} → ${f(on.r)}`);

  // ## 真正的判準：紅比藍高
  //
  // 白箱子 + 白光的話 R 與 B 應該一樣。紅色只能來自紅牆的反彈。
  const gapOn = on.r - on.b;
  const gapOff = off.r - off.b;
  check(gapOn > 6, '背光面偏紅 —— 那個紅只可能是牆反彈來的', `R−B = ${f(gapOn)}`);
  check(gapOn > gapOff + 5, '偏紅是間接光帶來的，不是本來就有', `R−B：${f(gapOff)} → ${f(gapOn)}`);

  // 沒有蓋掉直接光 —— 間接光是**加上去**的，不是取代。
  check(on.g >= off.g - 1, '沒有把原本的光蓋掉', `G ${f(off.g)} → ${f(on.g)}`);

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
