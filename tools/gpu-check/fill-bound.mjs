import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

/**
 * 這些內容是被 fragment 綁住，還是被幾何綁住？
 *
 * ## 這不是 gate，是一次性的探針
 *
 * 準則第八條說「每一個報出來的指標都要有一條會讓它失敗的線」。這支沒有線
 * ——它量的不是「有沒有退步」，是「接下來該做什麼」。所以它不進
 * `verify:all`，跑完之後結論寫進 roadmap，數字本身不需要每次重跑。
 *
 * ## 為什麼這個問題決定剩下的優先順序
 *
 * W6 剩下的三條軸（叢集 LOD、大地表、以及已經否決的遮蔽剔除）省的**全部
 * 都是幾何那一側**。如果 GPU 時間其實跟著像素數走，那它們的上限就是幾何
 * 佔的那一小塊，不管演算法多漂亮。
 *
 * Sponza 那次已經用拆解推過一次（幾何只佔 7.5%），但那是**推的**：
 * 三角形數 ÷ 天花板吞吐 + 繪製呼叫 × 固定成本。這支是直接量的。
 *
 * ## 判準
 *
 * 把畫布的邊長減半（像素數變四分之一），幾何完全不變：
 *
 * | 時間變成 | 代表 | 對剩下的軸 |
 * | --- | --- | --- |
 * | 約 1/4 | 被 fragment 綁住 | 幾何側的優化上限很低 |
 * | 幾乎不變 | 被幾何／繪製呼叫綁住 | 那些軸有得做 |
 *
 * 中間的話兩邊都有份，而斜率就是「fragment 佔多少」。
 *
 * ## 但畫布縮小的時候，幾何**也**會跟著變少
 *
 * 這是第一版的缺陷，而且是自己報出來的三角形數抓到的：近景那組縮到十六分
 * 之一像素時，三角形從 2,188,802 掉到 524,598（0.240 倍）。選階看的是螢幕
 * 誤差，而螢幕誤差跟著解析度走 —— 所以「縮小畫布」同時動了兩個變因，量到
 * 的「跟著像素走 90%」裡混著幾何少掉的那一份。
 *
 * 所以每個內容量兩次，第二次用 `?lodLevels=1&hlod=0` 把幾何**釘住**。釘住
 * 那一組的三角形數在三個尺寸下必須一樣 —— 那是這個實驗成不成立的自我檢查，
 * 所以它也印出來。
 *
 * 純色那組第一版就意外是個乾淨的對照：它的三階 LOD 早就全部飽和在最粗階，
 * 所以縮畫布時三角形數紋風不動（1.004 倍），而**時間只掉 11%**。
 */

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = join(root, 'apps/example/dist');

/**
 * 釘住的那一組用 `lodLevels=1&hlod=0`：只留最細的一階、關掉遠景合併，於是
 * 三角形數不再跟著解析度動。數量要調小 —— 遠景那組 20,000 個全部用最細的
 * 一階是一億個三角形、每幀 204 ms，而探針要的是「同樣的三角形數、不同的
 * 像素數」，不是那個規模。
 */
const SCENES = [
  {
    name: '近景・有貼圖（600 個大物件）',
    query: '?cooked=1&count=600&size=20&spread=400&orbit=90&hlodBudgetMB=512',
    frozen: '?cooked=1&count=600&size=20&spread=400&orbit=90&lodLevels=1&hlod=0',
  },
  {
    name: '遠景・有貼圖（20,000 個／釘住時 2,000 個）',
    query: '?cooked=1&count=20000&hlodBudgetMB=512',
    frozen: '?cooked=1&count=2000&lodLevels=1&hlod=0',
  },
  {
    name: '遠景・純色（60,000 個／釘住時 20,000 個）',
    query: '?count=60000&hlodBudgetMB=512',
    frozen: '?count=20000&lodLevels=1&hlod=0',
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
    for (const scene of SCENES) {
      console.log(`
${scene.name}`);
      for (const [label, query] of [
        ['選階照常（像素與幾何一起動）', scene.query],
        ['幾何釘住（只有像素在動）', scene.frozen],
      ]) {
        const page = await browser.newPage();
        await page.goto(site.url + query, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__ww?.totalFrames > 90, undefined, {
          timeout: 60_000,
        });
        const out = await page.evaluate(() => window.__ww.measureFillBound(6.0));
        await page.close();
        report(label, out);
      }
    }
  } finally {
    await browser.close();
    site.close();
  }
}

function report(label, out) {
  console.log(`  ${label}`);
  const full = out.full;
  for (const key of ['full', 'half', 'quarter']) {
    const r = out[key];
    if (r?.ms == null) {
      console.log(`    ${key.padEnd(8)} 量不到`);
      continue;
    }
    console.log(
      `    ${key.padEnd(8)} ${String(r.pixels).padStart(9)} 像素` +
        `   ${r.ms.toFixed(3).padStart(8)} ms` +
        `   ${r.triangles.toLocaleString('en-US').padStart(11)} 個三角形` +
        `   （像素 ${(r.pixels / full.pixels).toFixed(3)}、時間 ${(r.ms / full.ms).toFixed(3)}）`,
    );
  }
  const q = out.quarter;
  if (q?.ms == null) return;
  // 時間對像素的斜率：1 代表完全跟著像素走，0 代表完全不跟。
  const slope = (1 - q.ms / full.ms) / (1 - q.pixels / full.pixels);
  const triRatio = q.triangles / full.triangles;
  console.log(
    `    → 時間跟著像素走約 ${(slope * 100).toFixed(0)}%` +
      `（三角形變成 ${triRatio.toFixed(3)} 倍${triRatio > 0.99 ? '，確實釘住了' : ''}）`,
  );
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
  await new Promise((resolve) => server.listen(0, resolve));
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
