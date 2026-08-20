/**
 * 陰影 pass 自己剔除、自己選階。
 *
 * ## 兩個主張，兩個判準
 *
 * **一、相機看不到的東西照樣要投影。** Three 畫陰影時不會呼叫
 * `onBeforeRender`，所以沒有 `onBeforeShadow` 的話，陰影圖畫的是主相機那一次
 * 剔除留下來的清單 —— 相機看不到的投影者，影子就消失了。判準是「一顆完全
 * 在畫面外的球，它的影子在不在畫面裡」。
 *
 * **二、陰影用比較粗的階。** 陰影是被投影、被過濾過一次的東西，輪廓差幾個
 * 像素看不出來。判準是「陰影 pass 送的三角形數量」，用 Three 自己的計數器
 * （`renderer.info`）—— 不是我們自己的統計，兩套系統各自算才驗得到東西。
 *
 * A/B 都是同一份場景、同一條程式碼，只換一個選項。
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

const { check, finish, fail } = startReport('陰影 pass 自己的剔除與選階');

const browser = await launchBrowser({ webgpu: true });
const base = site.origin;

const run = async (query) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.setDefaultNavigationTimeout(240000);
  await page.goto(`${base}/?${query}&verify=1`, { waitUntil: 'load' });
  try {
    await page.waitForFunction(() => window.__ww?.shadowLod != null, undefined, { timeout: 60000 });
  } catch {
    const why = errors.length > 0 ? errors[0].slice(0, 300) : '（頁面沒有丟出任何錯誤）';
    throw new Error(`場景沒有建起來：${why}`);
  }
  const out = await page.evaluate(() => {
    const api = window.__ww.shadowLod;
    const spot = api.spot();
    const triangles = api.triangles();
    return {
      spot,
      triangles,
      counts: api.counts(),
      contract: api.contract(),
      stability: api.stability(6),
    };
  });
  await page.close();
  return { ...out, errors };
};

try {
  // ---- 一、相機看不到的投影者 ----
  const culled = await run('shadowlod=offscreen&shadowcull=1');
  const inherited = await run('shadowlod=offscreen&shadowcull=0');

  const ratio = (r) => r.spot.brightness / Math.max(r.spot.control, 1e-6);
  console.log(
    `  影子該落的點在畫面的 (${culled.spot.u.toFixed(3)}, ${culled.spot.v.toFixed(3)})，控制點在 (${culled.spot.controlU.toFixed(3)}, ${culled.spot.controlV.toFixed(3)})`,
  );
  console.log(
    `  自己剔除：影子處 ${culled.spot.brightness.toFixed(3)}、控制點 ${culled.spot.control.toFixed(3)}（${(ratio(culled) * 100).toFixed(0)}%），主畫面 ${culled.counts.visible} 個、陰影 ${culled.counts.shadow} 個`,
  );
  console.log(
    `  沿用相機：影子處 ${inherited.spot.brightness.toFixed(3)}、控制點 ${inherited.spot.control.toFixed(3)}（${(ratio(inherited) * 100).toFixed(0)}%），主畫面 ${inherited.counts.visible} 個、陰影 ${inherited.counts.shadow} 個`,
  );

  check(
    culled.spot.u > 0.02 && culled.spot.u < 0.98 && culled.spot.v > 0.02 && culled.spot.v < 0.98,
    `取樣點在畫面內 —— (${culled.spot.u.toFixed(3)}, ${culled.spot.v.toFixed(3)})`,
  );
  check(
    culled.counts.visible < 3,
    `那顆球確實被主相機剔掉了 —— 主畫面只剩 ${culled.counts.visible} 個 instance（共 3 個）`,
  );
  check(
    culled.counts.shadow > culled.counts.visible,
    `陰影 pass 看到的比主畫面多 —— 陰影 ${culled.counts.shadow} 個 > 主畫面 ${culled.counts.visible} 個`,
  );
  // ## 判準是「跟同一幀的控制點比」，不是一個寫死的亮度
  //
  // 被照亮的地面到底多亮取決於光強、環境光、色彩空間、色調映射 —— 全都
  // 不是這個關卡在測的東西。第一版猜 0.6，而實測的被照亮地面是 0.329。
  check(
    ratio(inherited) > 0.9,
    `沿用相機的清單時那個影子不見了 —— 影子處與控制點一樣亮（${(ratio(inherited) * 100).toFixed(0)}%）`,
  );
  check(
    ratio(culled) < 0.6,
    `自己剔除時影子回來了 —— 影子處只有控制點的 ${(ratio(culled) * 100).toFixed(0)}%`,
  );

  // ---- 二、陰影用比較粗的階 ----
  // 同一份 3,000 個的場景，只換陰影的誤差上限。errorPixels 預設 2，
  // 所以 shadowerr=2 等於「陰影與畫面一樣細」，不給就是預設的 6。
  const fine = await run('shadowlod=field&shadowerr=2');
  const coarse = await run('shadowlod=field');

  const drop = 1 - coarse.triangles / Math.max(fine.triangles, 1);
  console.log(
    `  陰影 pass 的三角形：一樣細 ${fine.triangles.toLocaleString()}，粗三倍 ${coarse.triangles.toLocaleString()}（少 ${(drop * 100).toFixed(1)}%）`,
  );
  console.log(
    `  陰影 pass 的 instance：一樣細 ${fine.counts.shadow}，粗三倍 ${coarse.counts.shadow}（兩邊該一樣多 —— 差的是階不是數量）`,
  );
  console.log(
    `  主畫面的階分布：一樣細 [${fine.counts.levels.join(', ')}]，粗三倍 [${coarse.counts.levels.join(', ')}]`,
  );
  console.log(
    `  陰影 pass 的階分布：一樣細 [${fine.counts.shadowLevels.join(', ')}]，粗三倍 [${coarse.counts.shadowLevels.join(', ')}]`,
  );

  // ## 正交投影下，選階不能看距離
  //
  // 陰影相機是正交的：同一個東西不管離光源多遠，在陰影圖上都佔一樣多的
  // 像素。所以一片同樣大小的東西必須全部落在**同一階** —— 裂成好幾階就
  // 代表距離混進了判準。
  //
  // 場地寬 120、光源在 120 外，最近與最遠差了好幾倍，這個問題才問得出來。
  const buckets = (c) => c.counts.shadowLevels.filter((n) => n > 0).length;
  /** 誤差契約自己算出來該用第幾階：誤差 × 半徑 × ppu ≤ errorPixels 的最粗那一階。 */
  const expectedLevel = (c) => {
    const { ppu, radius, errors, errorPixels } = c.contract;
    let level = 0;
    for (let l = 0; l < errors.length; l++) if (errors[l] * radius * ppu <= errorPixels) level = l;
    return level;
  };
  const chosen = (c) => c.counts.shadowLevels.findIndex((n) => n > 0);
  console.log(
    `  契約：ppu ${fine.contract.ppu.toFixed(2)}、半徑 ${fine.contract.radius} → 一樣細該用第 ${expectedLevel(fine)} 階（實際 ${chosen(fine)}），粗三倍該用第 ${expectedLevel(coarse)} 階（實際 ${chosen(coarse)}）`,
  );

  // ## 判準是「契約算出來該用第幾階」，不是「只用了一階」
  //
  // 「只用了一階」守不住它自己那句話：正交的距離 bug 會讓所有東西一起
  // 掉到最粗那一階 —— 仍然只有一階，檢查照樣綠。實測破壞過，確實綠。
  //
  // 而且用真實的平行光**量不到**「裂成好幾階」：距離要落在 0.18 到 7.3
  // 個單位之間才跨得過階的界線，而平行光的陰影相機在一百多個單位外。
  // 所以要問的不是分布的形狀，是**挑對了沒有**。
  check(
    buckets(fine) === 1 && chosen(fine) === expectedLevel(fine),
    `一樣細時挑的階符合誤差契約 —— 第 ${chosen(fine)} 階，契約說第 ${expectedLevel(fine)} 階`,
  );
  check(
    buckets(coarse) === 1 && chosen(coarse) === expectedLevel(coarse),
    `粗三倍時挑的階符合誤差契約 —— 第 ${chosen(coarse)} 階，契約說第 ${expectedLevel(coarse)} 階`,
  );

  // ## 量六次，六次要一樣
  //
  // 遠景合併是逐格烘出來的，烘到哪裡就合併到哪裡。合併的判準要是也漏掉了
  // 正交那條式子，陰影 pass 的數量就會一幀一幀往下掉，而且兩次跑不一樣。
  // 那種東西量不出任何事情 —— 先確定它是穩的，後面的數字才有意義。
  const drifting = (c) => new Set(c.stability).size > 1;
  console.log(
    `  連續六次的陰影 instance：一樣細 [${fine.stability.join(', ')}]，粗三倍 [${coarse.stability.join(', ')}]`,
  );
  check(
    !drifting(fine) && !drifting(coarse),
    `連續量六次答案不會飄 —— [${fine.stability.join(', ')}] / [${coarse.stability.join(', ')}]`,
  );

  check(fine.triangles > 0, `量得到陰影 pass 的三角形 —— ${fine.triangles.toLocaleString()}`);
  check(
    coarse.counts.shadow === fine.counts.shadow,
    `兩邊畫的 instance 一樣多 —— ${coarse.counts.shadow} 對 ${fine.counts.shadow}，差別只在選階`,
  );
  check(drop > 0.25, `粗三倍讓陰影少送至少四分之一的三角形 —— 少了 ${(drop * 100).toFixed(1)}%`);

  // ---- 三、被擋住的東西照樣要投影 ----
  //
  // 遮蔽緩衝是從**主相機**畫出來的，它說的是「這個東西被別的東西擋住，
  // 相機看不到」。看不到不等於不投影 —— 拿它剔除陰影，影子會憑空少一塊。
  //
  // 這與第一項是同一類的錯（把相機的結論套到光源上），只是換一種剔除。
  const occ = await run('shadowlod=occluded');
  console.log(
    `  遮蔽場：主畫面 ${occ.counts.visible} 個、剔掉 ${occ.counts.occluded} 個，陰影 pass ${occ.counts.shadow}/${occ.counts.total} 個`,
  );
  console.log(`  連續六次的陰影 instance：[${occ.stability.join(', ')}]`);

  check(
    occ.counts.occluded > occ.counts.total * 0.8,
    `遮蔽剔除真的有作用 —— 主畫面剔掉 ${occ.counts.occluded}/${occ.counts.total} 個`,
  );
  check(occ.counts.visible < 5, `主畫面幾乎只剩那顆擋路的大球 —— ${occ.counts.visible} 個`);
  check(
    occ.counts.shadow === occ.counts.total,
    `被擋住的照樣投影 —— 陰影 pass 畫了 ${occ.counts.shadow}/${occ.counts.total} 個`,
  );
} catch (error) {
  fail(String(error?.message ?? error));
} finally {
  await browser.close();
  site.close();
}

finish('陰影 pass 的剔除與選階');
