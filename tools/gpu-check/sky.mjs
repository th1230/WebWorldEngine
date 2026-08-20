/**
 * 天空：顏色是積分出來的，而且它會餵給間接光。
 *
 * ## 判準
 *
 * 藍天與紅日落在散射模型裡都不是常數 —— 它們是 Rayleigh 係數（藍光散得比紅光
 * 多）加上「陽光穿過的大氣有多厚」積出來的。所以「太陽高時天頂偏藍、太陽低時
 * 朝陽那面偏紅」這兩件事同時成立，就不可能是調出來的顏色。
 *
 * 而最重要的一條是接線：天空是 `scene.background`，探針是渲染場景烘出來的，
 * 所以日落時白色地面上的間接光應該是紅的。那個紅在這個全白的場景裡只有一個
 * 來源。
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

const { check, fail, finish } = startReport('天空：顏色是積分出來的，而且會餵給間接光');

const browser = await launchBrowser({ webgpu: true });
const base = site.origin;

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.setDefaultNavigationTimeout(240000);
  await page.goto(`${base}/?sky=1&verify=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ww?.sky != null, undefined, { timeout: 240000 });

  const out = await page.evaluate(async () => {
    const api = window.__ww.sky;

    // 正午。
    api.setSun(0.95);
    const noonZenith = api.sampleFace(2);
    const noonAway = api.sampleFace(1);
    const noonNadir = api.sampleFace(3);
    const bakesAfterNoon = api.bakes();
    // 太陽沒動 —— 不該重烘。
    api.setSun(0.95);
    const bakesUnchanged = api.bakes();

    const noonProbeCount = await api.bakeProbes();
    const noonProbe = api.probeAt([0, 1, 0]);

    // 日落：太陽貼著地平線，朝著 +x。
    api.setSun(0.02);
    const duskToward = api.sampleFace(0);
    const duskAway = api.sampleFace(1);
    const duskZenith = api.sampleFace(2);
    await api.bakeProbes();
    const duskProbe = api.probeAt([0, 1, 0]);

    // 太陽下山：陽光被地球擋住，天空該是暗的。
    api.setSun(-0.15);
    const nightToward = api.sampleFace(0);
    const nightZenith = api.sampleFace(2);

    return {
      noonZenith,
      noonAway,
      noonNadir,
      bakesAfterNoon,
      bakesUnchanged,
      noonProbe,
      noonProbeCount,
      duskToward,
      duskAway,
      duskZenith,
      duskProbe,
      nightToward,
      nightZenith,
    };
  });
  await page.close();

  const f = (v) => v.toFixed(4);
  const show = (c) => `${f(c[0])}, ${f(c[1])}, ${f(c[2])}`;
  console.log(
    `  正午 天頂 ${show(out.noonZenith)}   背陽 ${show(out.noonAway)}   地平線下 ${show(out.noonNadir)}`,
  );
  console.log(
    `  日落 朝陽 ${show(out.duskToward)}   背陽 ${show(out.duskAway)}   天頂 ${show(out.duskZenith)}`,
  );
  console.log(`  夜晚 朝陽 ${show(out.nightToward)}   天頂 ${show(out.nightZenith)}`);
  console.log(`  探針（白色地面）正午 ${show(out.noonProbe)}   日落 ${show(out.duskProbe)}`);
  console.log(`  重烘次數 ${out.bakesAfterNoon}，太陽沒動之後 ${out.bakesUnchanged}\n`);

  // ## 要看**背著太陽那一半**的天空
  //
  // 太陽附近的天空本來就偏白 —— 那是 Mie 的前向散射（日暈），是對的物理。
  // 第一版把太陽拉到接近天頂，然後量天頂，等於在量太陽自己那一圈：B/R 只有
  // 1.38，看起來像模型不夠藍，其實是取樣點挑錯了。
  //
  // 深藍色的天空一直都在背著太陽的那一半。
  check(
    out.noonAway[2] > out.noonAway[0] * 1.8,
    `正午背著太陽那半邊是藍的 —— B ${f(out.noonAway[2])} vs R ${f(out.noonAway[0])}`,
  );
  check(
    out.noonZenith[2] > out.noonZenith[0],
    `太陽附近偏白但仍然偏藍（Mie 日暈）—— B ${f(out.noonZenith[2])} vs R ${f(out.noonZenith[0])}`,
  );
  check(
    out.duskToward[0] > out.duskToward[2] * 1.2,
    `日落朝著太陽那一面偏紅 —— R ${f(out.duskToward[0])} vs B ${f(out.duskToward[2])}`,
  );
  check(
    out.duskToward[0] > out.duskAway[0] * 1.5,
    `朝陽比背陽亮（Mie 前向散射）—— R ${f(out.duskToward[0])} vs ${f(out.duskAway[0])}`,
  );
  check(
    out.noonNadir[0] + out.noonNadir[1] + out.noonNadir[2] < 0.05,
    `地平線下是暗的 —— ${show(out.noonNadir)}（地球擋住了）`,
  );
  check(
    out.nightToward[0] + out.nightToward[1] + out.nightToward[2] < out.duskToward[0] * 0.5,
    `太陽下山之後天空暗下來 —— 朝陽那面總和 ${f(out.nightToward[0] + out.nightToward[1] + out.nightToward[2])}（日落時只 R 就有 ${f(out.duskToward[0])}）`,
  );
  check(
    out.nightZenith[0] + out.nightZenith[1] + out.nightZenith[2] < 0.02,
    `夜晚天頂幾乎全黑 —— ${show(out.nightZenith)}（少了「陽光被地球擋住」那條檢查，這裡會亮著）`,
  );
  check(
    out.bakesUnchanged === out.bakesAfterNoon,
    `太陽沒動就不重烘 —— ${out.bakesAfterNoon} 次沒有變`,
  );
  check(out.noonProbeCount > 0, `探針烘得起來 —— ${out.noonProbeCount} 顆`);
  check(
    out.noonProbe[2] > out.noonProbe[0],
    `正午白色地面上的間接光偏藍（來自藍天）—— B ${f(out.noonProbe[2])} vs R ${f(out.noonProbe[0])}`,
  );
  check(
    out.duskProbe[0] / Math.max(out.duskProbe[2], 1e-6) >
      (out.noonProbe[0] / Math.max(out.noonProbe[2], 1e-6)) * 1.5,
    `日落的間接光比正午紅得多 —— R/B 從 ${f(out.noonProbe[0] / Math.max(out.noonProbe[2], 1e-6))} 變成 ${f(out.duskProbe[0] / Math.max(out.duskProbe[2], 1e-6))}`,
  );
  check(
    errors.length === 0,
    `沒有主控台錯誤${errors.length > 0 ? '：' + errors[0].slice(0, 140) : ''}`,
  );
} catch (e) {
  fail('關卡跑到一半就掛了', String(e).split(String.fromCharCode(10))[0].slice(0, 240));
  process.exitCode = 1;
}
await browser.close();
site.close();

finish('天空關卡');
