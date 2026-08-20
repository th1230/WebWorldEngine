/**
 * 虛擬陰影圖：解析度要真的比圖集大。
 *
 * ## 判準是斜邊界的階梯
 *
 * 陰影圖解析度不足時，邊界被量化成一格一格的階梯。水平或垂直的邊界看不出來
 * （階梯剛好對齊），**斜的**才看得出來。
 *
 * 所以掃過幾十列、看陰影邊界落在幾個不同的位置：解析度夠的話每一列都不一樣
 * （平滑地斜過去），不夠的話好幾列共用同一個位置。
 *
 * A/B 是**同一條程式碼、不同的虛擬解析度** —— 一個遠大於圖集，一個等於圖集
 * （也就是退化成一張普通的陰影圖）。換實作做 A/B 說明不了解析度。
 */
import { join } from 'node:path';
import { assertDistFresh } from '../lib/dist-fresh.mjs';
import { serveDist } from '../lib/serve.mjs';
import { launchBrowser } from '../lib/browser.mjs';
import { ROOT } from '../lib/repo-root.mjs';
import { startReport } from '../lib/report.mjs';

// 關卡吃的是建好的產物 —— 它比原始碼舊的話，這一輪的每個數字都沒有意義。
assertDistFresh(ROOT);
const DIST = join(ROOT, 'apps/example/dist');
const site = await serveDist(DIST);

const { check, fail, finish } = startReport('虛擬陰影圖：解析度要真的比圖集大');

const browser = await launchBrowser({ webgpu: true });
const base = site.origin;

const run = async (pagesPerSide) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.setDefaultNavigationTimeout(240000);
  await page.goto(`${base}/?vsm=${pagesPerSide}&verify=1`, { waitUntil: 'load' });
  // ## 等不到就要說出**為什麼**
  //
  // 場景建構丟例外的話整個模組載入失敗，`__ww.vsm` 永遠不會出現 —— 而
  // 原本只會看到一行「逾時」。實測踩過：pagesPerSide 給了非 2 的次方，
  // PageTable 正確地丟了例外，而關卡完全看不出原因。
  try {
    await page.waitForFunction(() => window.__ww?.vsm != null, undefined, { timeout: 60000 });
  } catch {
    const why = errors.length > 0 ? errors[0].slice(0, 300) : '（頁面沒有丟出任何錯誤）';
    throw new Error(`場景沒有建起來：${why}`);
  }
  const out = await page.evaluate(() => {
    const api = window.__ww.vsm;
    const drawn = api.settle();
    api.resolve(1);
    const uvDepth = api.maskStats().centre;
    api.resolve(-1);
    const stored = api.maskStats().centre;
    api.resolve(2);
    const entry = api.maskStats().centre;
    api.resolve(-2);
    const atlasUv = api.maskStats().centre;
    api.resolve(0);
    api.resolve(3);
    const diffMap = api.maskMap();
    const diffCentre = api.maskStats().centre;
    api.resolve(0);
    const map = api.maskMap();
    return {
      map,
      diffMap,
      diffCentre,
      uvDepth,
      stored,
      entry,
      atlasUv,
      drawn,
      columns: api.edgeColumns(),
      info: api.info(),
      mask: api.maskStats(),
    };
  });
  await page.close();
  return { ...out, errors };
};

/** 邊界落在幾個不同的位置。階梯越粗，這個數字越小。 */
const distinct = (columns) => new Set(columns.filter((c) => c >= 0)).size;

try {
  // 32 頁 × 64 = 2048，剛好等於圖集 —— 也就是一張普通的陰影圖。
  const coarse = await run(32);
  // 512 頁 × 64 = 32,768，遠大於圖集，也大於硬體上限。
  const fine = await run(512);

  const found = (c) => c.columns.filter((x) => x >= 0).length;
  console.log(
    `  粗（虛擬 ${coarse.info.virtualSize}，圖集 ${coarse.info.atlasSize}）：畫了 ${coarse.drawn} 頁，抓到邊界 ${found(coarse)}/96 列，落在 ${distinct(coarse.columns)} 個不同位置`,
  );
  console.log(
    `  細（虛擬 ${fine.info.virtualSize}，圖集 ${fine.info.atlasSize}）：畫了 ${fine.drawn} 頁，抓到邊界 ${found(fine)}/96 列，落在 ${distinct(fine.columns)} 個不同位置`,
  );
  console.log(
    `  中心像素：細 uv+depth ${fine.uvDepth} 圖集深度 ${fine.stored}，頁表 ${fine.entry}，圖集 uv ${fine.atlasUv}`,
  );
  const draw = (m) => {
    for (let r = 8; r >= 0; r--) {
      console.log(
        '    ' +
          m
            .slice(r * 16, (r + 1) * 16)
            .map((v) => (v > 200 ? '#' : v > 128 ? '+' : v > 40 ? '.' : ' '))
            .join(''),
      );
    }
  };
  console.log('  粗的遮罩：');
  draw(coarse.map);
  console.log('  細的遮罩：');
  draw(fine.map);
  console.log(`  stored − depth（0.5 = 相等，每格 0.05）：中心 ${fine.diffCentre[0] / 255}`);
  draw(fine.diffMap);
  console.log(
    `  遮罩：粗 暗 ${(coarse.mask.dark * 100).toFixed(1)}% 平均 ${coarse.mask.mean.toFixed(3)}，細 暗 ${(fine.mask.dark * 100).toFixed(1)}% 平均 ${fine.mask.mean.toFixed(3)}`,
  );
  console.log(`  這台機器的 maxTextureSize：${fine.info.maxTextureSize}\n`);

  check(
    fine.info.virtualSize > fine.info.maxTextureSize,
    `假裝出來的比硬體上限大 —— ${fine.info.virtualSize} > ${fine.info.maxTextureSize}`,
  );
  check(
    fine.info.atlasSize <= fine.info.maxTextureSize,
    `真正配置的在上限內 —— ${fine.info.atlasSize}`,
  );
  check(
    found(coarse) > 60 && found(fine) > 60,
    `兩邊都抓得到陰影邊界 —— ${found(coarse)} / ${found(fine)} 列`,
  );
  check(
    distinct(fine.columns) > distinct(coarse.columns) * 1.8,
    `細的那一份邊界平滑得多 —— ${distinct(coarse.columns)} → ${distinct(fine.columns)} 個不同位置`,
  );
  check(
    fine.errors.length === 0,
    `沒有主控台錯誤${fine.errors.length > 0 ? '：' + fine.errors[0].slice(0, 140) : ''}`,
  );
} catch (e) {
  fail('關卡跑到一半就掛了', String(e).split(String.fromCharCode(10))[0].slice(0, 240));
  process.exitCode = 1;
}
await browser.close();
site.close();

finish('虛擬陰影圖關卡');
