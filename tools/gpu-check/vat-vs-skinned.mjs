import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { assertDistFresh } from '../lib/dist-fresh.mjs';
import { serveDist } from '../lib/serve.mjs';
import { ROOT } from '../lib/repo-root.mjs';
import { launchBrowser } from '../lib/browser.mjs';

/**
 * VAT 對逐 instance 蒙皮，同一根 rig。
 *
 * 這條軸的量尺（`skinned-scaling.mjs`）說：成本在**逐 instance** 那一側 ——
 * 800 個蒙皮模型是 740 次繪製、7.566 ms，而三角形只值 1.02 ms。VAT 把動畫
 * 烘成貼圖，於是幾何變回靜態的，批次／剔除／選階全部重新適用。
 *
 * 這支就是驗那個推論成不成立。
 *
 * ## 除了時間，還要看三角形數與繪製次數
 *
 * shader 注入失敗的症狀是**畫面上什麼都沒有**，而那會量到一個非常漂亮的時間。
 * 這一輪已經踩過一次（MultiMesh 沒呼叫 super，量到 1.589 ms 對 7.998 ms，
 * 實際上一個三角形都沒畫）。所以三角形數要印在時間旁邊。
 */

// 關卡吃的是建好的產物 —— 它比原始碼舊的話，這一輪的每個數字都沒有意義。
assertDistFresh(ROOT);
const DIST = join(ROOT, 'apps/example/dist');
const COUNTS = [200, 800, 3200];

async function main() {
  console.log('建置 example…');
  execFileSync('pnpm', ['--filter', '@ww/example-app', 'build'], {
    cwd: ROOT,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  const site = await serve(DIST);
  const browser = await launchBrowser();
  try {
    for (const count of COUNTS) {
      const row = {};
      for (const [key, query] of [
        ['蒙皮', `?skinned=${count}&spread=120&orbit=90`],
        ['VAT', `?vat=${count}&spread=120&orbit=90&vatLod=0`],
        ['VAT+LOD', `?vat=${count}&spread=120&orbit=90`],
      ]) {
        const page = await browser.newPage();
        const errors = [];
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(m.text().split('\n')[0]);
        });
        page.on('pageerror', (e) => errors.push(String(e.message).split('\n')[0]));
        await page.goto(site.url + query, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__ww?.totalFrames > 60, undefined, {
          timeout: 120_000,
        });
        const r = await page.evaluate(() => {
          const w = window.__ww;
          w.renderer.info.reset();
          w.step(6);
          const { calls, triangles } = w.renderer.info.render;
          return w.measureGpuMs(6).then((g) => ({ ms: g.p50, calls, triangles, vat: w.vat }));
        });
        await page.close();
        row[key] = r;
        console.log(
          `  ${String(count).padStart(4)} 個  ${key.padEnd(5)} ${r.ms.toFixed(3).padStart(8)} ms   ` +
            `${String(r.calls).padStart(5)} 次繪製   ${r.triangles.toLocaleString('en-US').padStart(9)} 個三角形` +
            (errors.length > 0 ? `   ⚠ ${errors[0]}` : ''),
        );
      }
      const a = row['蒙皮'];
      const b = row['VAT'];
      const c = row['VAT+LOD'];
      // 三角形數對不上就代表其中一邊沒畫對，那時比時間沒有意義。
      const sameGeometry = Math.abs(b.triangles - a.triangles) / Math.max(a.triangles, 1) < 0.02;
      // 關掉 LOD 那一組是**同樣三角形數**的比較，回答「批次本身值多少」。
      console.log(
        `        → 只算批次（同樣三角形數）：省 ${((1 - b.ms / a.ms) * 100).toFixed(1)}%、繪製 ${a.calls} → ${b.calls}` +
          (sameGeometry ? '' : '   ⚠ 三角形數對不上，這個比較不成立'),
      );
      // 開 LOD 那一組是**整條路**的比較 —— 三角形數本來就會少，那是 LOD 的功勞。
      console.log(
        `           整條路（含 LOD）：省 ${((1 - c.ms / a.ms) * 100).toFixed(1)}%，三角形 ${a.triangles.toLocaleString('en-US')} → ${c.triangles.toLocaleString('en-US')}`,
      );
      if (c.vat)
        console.log(
          `          （貼圖 ${c.vat.textureMB} MB：${c.vat.vertices} 頂點 × ${c.vat.frames} 幀）`,
        );
    }
  } finally {
    await browser.close();
    site.close();
  }
}

async function serve(dir) {
  const COOKED = join(ROOT, 'apps/benchmark/public');
  const site = await serveDist(dir, { mounts: { '/cooked': COOKED } });
  return { url: site.url, close: () => site.close() };
}

await main();
