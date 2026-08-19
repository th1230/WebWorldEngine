import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
import { listenSafe } from '../lib/listen-safe.mjs';
import { assertDistFresh } from '../lib/dist-fresh.mjs';

/**
 * 「會動的東西」那條軸的第一步：**成本怎麼隨數量成長**。
 *
 * ## 為什麼是量而不是做
 *
 * 這條軸打掉這個引擎的核心假設：`BatchedMesh` 不支援骨骼蒙皮，所以整套
 * （批次、LOD 鏈、遠景合併）對它完全無效。UE 遇到同樣的問題是繞開的 ——
 * 用 VAT（把動畫烘進貼圖，在 vertex shader 取樣）把會動的變回像不會動的。
 *
 * 但在做 VAT 之前要先知道兩件事，而兩件都是量出來的：
 *
 * 1. **原生今天到哪裡就撐不住** —— 那是這條軸的起點。
 * 2. **成本是逐 instance 還是逐三角形** —— 決定 VAT 值不值得。VAT 省的是
 *    「逐 instance 的骨骼矩陣與繪製呼叫」，如果成本其實在三角形上，它就
 *    救不了。
 *
 * 兩者都不知道就開始寫，就是準則說的「先做再量」。
 *
 * ## 這支不回答什麼
 *
 * 內容是程序化的蒙皮圓柱（576 個三角形、8 根骨頭），所以**絕對吞吐量不能
 * 拿這裡的數字推論**。它回答的是曲線的形狀，不是某個模型跑多快。
 *
 * 真的資產在 `assets/source/gltf-sample`（22 個有動畫的，BrainStem 61,666
 * 個三角形／18 根骨頭），那要等 cook 支援蒙皮之後才接得進來。
 */

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// 關卡吃的是建好的產物 —— 它比原始碼舊的話，這一輪的每個數字都沒有意義。
assertDistFresh(root);
const DIST = join(root, 'apps/example/dist');
const COUNTS = [50, 100, 200, 400, 800];

async function main() {
  console.log('建置 example…');
  execFileSync('pnpm', ['--filter', '@ww/example-app', 'build'], {
    cwd: root,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  const site = await serve(DIST);
  const browser = await launch();
  const rows = [];
  try {
    for (const count of COUNTS) {
      const page = await browser.newPage();
      await page.goto(`${site.url}?skinned=${count}&spread=120&orbit=90`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__ww?.totalFrames > 60, undefined, { timeout: 60_000 });
      const r = await page.evaluate(() => {
        const w = window.__ww;
        w.renderer.info.reset();
        w.step(6);
        const { calls, triangles } = w.renderer.info.render;
        return w.measureGpuMs(6).then((g) => ({ ms: g.p50, calls, triangles, info: w.skinned }));
      });
      await page.close();
      rows.push({ count, ...r });
      console.log(
        `  ${String(count).padStart(4)} 個   ${r.ms.toFixed(3).padStart(8)} ms   ` +
          `${String(r.calls).padStart(5)} 次繪製   ${r.triangles.toLocaleString('en-US').padStart(9)} 個三角形`,
      );
    }
  } finally {
    await browser.close();
    site.close();
  }

  console.log('');
  // 逐 instance 的邊際成本：兩點之間的斜率。固定的話代表成本與數量成正比，
  // 也就是逐 instance；越來越大代表有別的東西在飽和。
  for (let i = 1; i < rows.length; i++) {
    const dMs = rows[i].ms - rows[i - 1].ms;
    const dCount = rows[i].count - rows[i - 1].count;
    console.log(
      `  ${rows[i - 1].count} → ${rows[i].count} 個：每多一個 ${((dMs / dCount) * 1000).toFixed(1)} µs`,
    );
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  console.log('');
  console.log(
    `  每個 ${first.triangles / first.count} 個三角形、${first.info?.bones ?? '?'} 根骨頭；` +
      `${last.count} 個時共 ${last.triangles.toLocaleString('en-US')} 個三角形、${last.ms.toFixed(2)} ms`,
  );
  // 拿三角形那一側對照：這麼多三角形若是靜態的，照量到的邊際速率只要多少時間。
  console.log(
    `  同樣的三角形數若是靜態批次（實測邊際 196,305 三角形/ms）約需 ` +
      `${(last.triangles / 196305).toFixed(2)} ms —— 差距就是蒙皮與逐 instance 的成本`,
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
