import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
import { listenSafe } from '../lib/listen-safe.mjs';
import { assertDistFresh } from '../lib/dist-fresh.mjs';

/**
 * 「大地表」與「一個極細物件」那兩條軸：**分塊值多少**。
 *
 * ## 兩條軸其實是同一個問題
 *
 * 從外面看的密物件整顆離相機差不多遠，所以「整顆挑一階」已經接近最佳解。
 * 真正需要逐區域選階的是**跨越很大深度範圍**的東西 —— 腳下清清楚楚、
 * 地平線那端只有幾個像素，而它們是同一個物件。地表是這個形狀的標準案例。
 *
 * ## 量法
 *
 * 同一片地形（高度用世界座標算，所以切幾塊都是同一片），同樣的總三角形數，
 * 只換切成幾塊：
 *
 * - `terrain=1` —— 整片一份幾何，也就是今天直接丟進 Three 的樣子
 * - `terrain=N` —— N×N 塊，每塊自己選階、自己被剔除
 *
 * 三角形總數固定（`terrainSeg` 跟著調），所以差的只有「分塊」這一件事。
 *
 * ## 為什麼這個缺口是 API 的形狀，不是機制
 *
 * `WW.InstancedMesh(geometry, material, count)` 假設**所有 instance 共用同一份
 * 幾何**，而地表每一塊的高度都不一樣 —— 那是 N 份相異的幾何。
 *
 * 底層的 `BatchedMesh` 其實裝得下相異幾何（LOD 鏈就是這樣塞的），所以擋住的
 * 是那個建構子的形狀。這支量的就是「把它打開」值多少。
 *
 * 現在只能一塊一個 `InstancedMesh(count=1)` 來模擬，那會付掉每塊一份物件的
 * 開銷 —— 所以量到的是**下界**，真的做進去只會更好。
 */

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// 關卡吃的是建好的產物 —— 它比原始碼舊的話，這一輪的每個數字都沒有意義。
assertDistFresh(root);
const DIST = join(root, 'apps/example/dist');

/**
 * 兩個規模都要量，而且第一輪就是被這件事教的。
 *
 * 52 萬個三角形那一輪最多只省 15%，而且 16×16 時反而變慢 —— 因為那個量對
 * 這台機器根本不算什麼（照實測邊際 196,305 三角形/ms，整片也才 2.7 ms）。
 * **內容不夠大的時候，這條軸的價值量不出來，而那不是「這條軸沒價值」。**
 *
 * 所以加一輪 8 倍大的。總三角形數在每一輪內固定，所以差的只有分塊。
 */
const SCALES = [
  {
    name: '52 萬個三角形',
    cases: [
      { tiles: 1, seg: 512, label: '整片一份幾何' },
      { tiles: 4, seg: 128, label: '4×4 塊' },
      { tiles: 8, seg: 64, label: '8×8 塊' },
      { tiles: 16, seg: 32, label: '16×16 塊' },
    ],
  },
  {
    name: '420 萬個三角形',
    cases: [
      { tiles: 1, seg: 1448, label: '整片一份幾何' },
      { tiles: 4, seg: 362, label: '4×4 塊' },
      { tiles: 8, seg: 181, label: '8×8 塊' },
      { tiles: 16, seg: 90, label: '16×16 塊' },
    ],
  },
];

async function main() {
  console.log('建置 example…');
  execFileSync('pnpm', ['--filter', '@ww/example-app', 'build'], {
    cwd: root,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  const site = await serve(DIST);
  const browser = await launch();
  try {
    for (const scale of SCALES) {
      console.log(`\n${scale.name}`);
      const rows = [];
      for (const c of scale.cases) {
        const page = await browser.newPage();
        await page.goto(`${site.url}?terrain=${c.tiles}&terrainSeg=${c.seg}`, {
          waitUntil: 'load',
        });
        await page.waitForFunction(() => window.__ww?.totalFrames > 60, undefined, {
          timeout: 180_000,
        });
        const r = await page.evaluate(() => {
          const w = window.__ww;
          w.renderer.info.reset();
          w.step(6);
          const { calls, triangles } = w.renderer.info.render;
          return w.measureGpuMs(6).then((g) => ({ ms: g.p50, calls, triangles, info: w.terrain }));
        });
        await page.close();
        rows.push({ ...c, ...r });
        console.log(
          `  ${c.label.padEnd(14)} ${r.ms.toFixed(3).padStart(8)} ms   ` +
            `${String(r.calls).padStart(4)} 次繪製   ` +
            `畫了 ${r.triangles.toLocaleString('en-US').padStart(9)} / 建了 ${r.info.triangles.toLocaleString('en-US')} 個三角形`,
        );
      }
      const base = rows[0];
      for (const r of rows.slice(1)) {
        console.log(
          `    → ${r.label.padEnd(12)} 時間省 ${((1 - r.ms / base.ms) * 100).toFixed(1)}%，` +
            `三角形少 ${((1 - r.triangles / base.triangles) * 100).toFixed(1)}%`,
        );
      }
    }
  } finally {
    await browser.close();
    site.close();
  }

  console.log('\n（一塊一個 InstancedMesh 是模擬，會付掉每塊一份物件的開銷 —— 所以這是下界。）');
}

async function serve(dir) {
  const COOKED = join(root, 'apps/benchmark/public');
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = path.startsWith('/cooked')
      ? join(COOKED, path)
      : join(dir, path === '/' ? 'index.html' : path);
    readFile(file).then(
      (bytes) => {
        const type =
          { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }[
            extname(file)
          ] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type });
        res.end(bytes);
      },
      () => res.writeHead(404).end(),
    );
  });
  await listenSafe(server);
  return { url: `http://localhost:${server.address().port}/`, close: () => server.close() };
}

async function launch() {
  const errors = [];
  for (const channel of ['chrome', undefined]) {
    try {
      return await chromium.launch(channel === undefined ? {} : { channel });
    } catch (error) {
      errors.push(String(error).split('\n')[0]);
    }
  }
  throw new Error(`無法啟動瀏覽器：\n  ${errors.join('\n  ')}`);
}

await main();
