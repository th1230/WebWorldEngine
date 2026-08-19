import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
import { listenSafe } from '../lib/listen-safe.mjs';
import { assertDistFresh } from '../lib/dist-fresh.mjs';

/**
 * VAT 在 **WebGPU / node 材質** 那條路上到底有沒有動。
 *
 * ## 為什麼需要它
 *
 * VAT 有兩份實作：WebGL 那份注入 GLSL，WebGPU 那份設 `positionNode`（TSL）。
 * 主範例跑的是 `WebGLRenderer`，所以它永遠驗不到另一份。
 *
 * 而**兩份的失效方式一模一樣**：模型停在綁定姿勢、不報錯、幀時間還特別好看。
 * 這一輪已經被這個形態騙過三次（材質旋鈕、MultiMesh 沒呼叫 super、VAT 的
 * `batchId`），三次的數字都完全自洽。
 *
 * ## 判準：兩個時間點的畫面必須不一樣
 *
 * 「有沒有跑完」「有沒有錯誤」都不算 —— 沒接上的話兩者都正常。唯一問得對的
 * 問題是**它有沒有在動**，而那要比兩個時間點的像素。
 *
 * 同時也收 console error：TSL 那份若組不出來，錯誤只會出現在那裡。
 */

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// 關卡吃的是建好的產物 —— 它比原始碼舊的話，這一輪的每個數字都沒有意義。
assertDistFresh(root);
const DIST = join(root, 'apps/example/dist');

async function main() {
  console.log('建置 example…');
  execFileSync('pnpm', ['--filter', '@ww/example-app', 'build'], {
    cwd: root,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  const site = await serve(DIST);
  // 有頭 + `--enable-unsafe-webgpu`：無頭那組拿不到 adapter（實測
  // requestAdapter 回傳 null）。而 `about:blank` 上連 navigator.gpu 都沒有
  // ——WebGPU 需要安全上下文，所以一定要先 goto 到真的 origin。
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--enable-unsafe-webgpu'],
  });
  let failed = false;
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text().split('\n')[0]);
    });
    page.on('pageerror', (e) => errors.push(String(e.message).split('\n')[0]));

    await page.goto(`${site.url}webgpu.html?count=200`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__wwgpu !== undefined, undefined, { timeout: 60_000 });
    await page.waitForFunction(() => window.__wwgpu.frames() > 5, undefined, { timeout: 60_000 });

    const triangles = await page.evaluate(() => window.__wwgpu.step(0));
    const a = await page.screenshot();
    await page.evaluate(() => window.__wwgpu.step(0.9));
    const b = await page.screenshot();

    const differs = Buffer.compare(a, b) !== 0;
    console.log(`  三角形 ${triangles.toLocaleString('en-US')}`);
    console.log(`  兩個時間點的畫面${differs ? '不一樣 → 有在動' : '**完全一樣 → 沒有在動**'}`);
    if (errors.length > 0) for (const e of errors.slice(0, 4)) console.log('  ⚠ ' + e);

    // 三角形是 0 的話代表根本沒畫，那時「畫面不一樣」也不能證明什麼。
    if (triangles === 0) {
      console.error('\nFAIL: 一個三角形都沒畫 —— node 材質那條路沒有畫出東西。');
      failed = true;
    } else if (!differs) {
      console.error(
        '\nFAIL: 兩個時間點的畫面一模一樣 —— 模型停在綁定姿勢，' +
          'TSL 那份沒有接上（而它不會報錯）。',
      );
      failed = true;
    } else if (errors.length > 0) {
      console.error('\nFAIL: 有 console error，即使畫面看起來有動也不能算過。');
      failed = true;
    } else {
      console.log('\nOK: WebGPU / node 材質上頂點動畫有生效');
    }
    await page.close();
  } finally {
    await browser.close();
    site.close();
  }
  if (failed) process.exitCode = 1;
}

async function serve(dir) {
  const COOKED = join(root, 'apps/benchmark/public');
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    // 瀏覽器一定會要 favicon，而這台伺服器沒有 —— 那個 404 會被下面
    // 「有 console error 就不算過」判成失敗。它是這支工具的缺口，不是被測
    // 程式的問題，所以直接回 204。
    if (path === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    const file = path.startsWith('/cooked')
      ? join(COOKED, path)
      : path.startsWith('/source-assets')
        ? join(root, 'assets/source', path.slice('/source-assets/'.length))
        : join(dir, path === '/' ? 'index.html' : path);
    readFile(file).then(
      (bytes) => {
        const type =
          {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.json': 'application/json',
            '.glb': 'model/gltf-binary',
          }[extname(file)] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type });
        res.end(bytes);
      },
      () => res.writeHead(404).end(),
    );
  });
  await listenSafe(server);
  return { url: `http://localhost:${server.address().port}/`, close: () => server.close() };
}

await main();
