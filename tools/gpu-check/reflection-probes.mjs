/**
 * 反射探針：反射裡要有**實際拍到的東西**，而且要跟著串流更新。
 *
 * ## 三個主張
 *
 * **一、方向是對的。** 探針把整個方向球攤成一張正方形（八面體映射），而那個
 * 對應在 CPU 與 GLSL 各有一份實作。兩份對不起來的症狀是「反射裡的世界被鏡射
 * 或轉了 90 度」—— 單一顏色的環境完全看不出來。所以房間四面牆各一個顏色，
 * 判準是「地板偏 +x 那一塊照出紅色、偏 −x 那一塊照出藍色」。
 *
 * **二、它補的是原本答不出來的那一段。** 關掉探針時，什麼都沒打到就用一個
 * 寫死的天空色。牆完全不在畫面上（相機直接俯看地板），所以螢幕空間那一層
 * 找不到它們 —— 那正是探針存在的理由。
 *
 * **三、串流進來的東西要進得了反射。** 一面牆一開始藏著（內容還沒串流到），
 * 烘完之後現身。沒有通知探針的話它會**永遠**留在舊資料上；通知了才會重烘。
 *
 * 量的是同一個像素在幾種狀態下的顏色 —— 同一條程式碼、同一個場景。
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

const { check, finish, markFailed } = startReport('反射探針：反射裡要有實際拍到的東西');

const browser = await launchBrowser({ webgpu: true });
const base = site.origin;
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
page.setDefaultNavigationTimeout(240000);

/** 三個通道裡哪一個最強，以及它比第二強的高多少倍。 */
const dominant = (rgb) => {
  const names = ['R', 'G', 'B'];
  const order = rgb.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  return {
    channel: names[order[0][1]],
    value: order[0][0],
    ratio: order[0][0] / Math.max(order[1][0], 1e-4),
  };
};
const show = (rgb) => rgb.map((v) => v.toFixed(3)).join(' / ');

try {
  await page.goto(`${base}/?reflprobe=1&verify=1`, { waitUntil: 'load' });
  try {
    await page.waitForFunction(() => window.__ww?.reflProbe != null, undefined, { timeout: 60000 });
  } catch {
    const why = errors.length > 0 ? errors[0].slice(0, 300) : '（頁面沒有丟出任何錯誤）';
    throw new Error(`場景沒有建起來：${why}`);
  }

  const out = await page.evaluate(async () => {
    const api = window.__ww.reflProbe;
    const baked = await api.settle();
    const info = api.info();

    // 取樣點：地板上偏 +x 與偏 −x 各一個。地板法線朝上，所以偏 +x 那一點
    // 的反射方向水平分量也是 +x —— 它照出來的該是 +x 那面牆。
    // 偏 +z 那一點是「串流進來的那面牆」要照到的地方。三個點都要在畫面裡，
    // 而且反射方向都要真的打到對應的那面牆 —— 兩件事一起限制了它們的位置。
    const FRONT = [0, 25];
    // ## 偏 −z 那一點驗的是八面體的**折疊**那一段
    //
    // 八面體映射把方向 z < 0 的那半球「折」到正方形的四個角。z ≥ 0 的方向
    // 根本不走那條分支 —— 而右/左/前三個點的反射方向 z 都 ≥ 0。
    //
    // 實測過：把 GLSL 的折法改錯（跟 CPU 那份不一樣），三個點**全部照樣
    // 通過**，數字還更漂亮。場景裡不存在那個情況的話，斷言再嚴也問不出來。
    const BACK = [0, -25];
    const spots = { right: [30, 0], left: [-30, 0], front: FRONT, back: BACK };
    const screen = {};
    for (const [name, [x, z]] of Object.entries(spots)) screen[name] = api.screen(x, z);

    api.render(true);
    const withProbes = {};
    for (const [name, [x, z]] of Object.entries(spots)) withProbes[name] = api.sample(x, z);

    api.render(false);
    const without = {};
    for (const [name, [x, z]] of Object.entries(spots)) without[name] = api.sample(x, z);

    // ---- 串流那一半 ----
    // 牆現身，但**先不通知**。探針該留在舊資料上。
    api.reveal();
    api.render(true);
    const revealedNoInvalidate = api.sample(FRONT[0], FRONT[1]);
    const staleAfterReveal = api.info().stale;

    // 現在通知，重烘。
    const marked = api.invalidate();
    await api.settle();
    api.render(true);
    const revealedInvalidated = api.sample(FRONT[0], FRONT[1]);

    return {
      baked,
      info,
      screen,
      withProbes,
      without,
      revealedNoInvalidate,
      staleAfterReveal,
      marked,
      revealedInvalidated,
      after: api.info(),
    };
  });

  console.log(
    `  探針 ${out.info.probes} 顆，烘了 ${out.baked} 顆，圖塊寫了 ${out.info.written} 塊`,
  );
  console.log(
    `  取樣點在畫面的 右 (${out.screen.right.map((v) => v.toFixed(2)).join(', ')})、左 (${out.screen.left.map((v) => v.toFixed(2)).join(', ')})、前 (${out.screen.front.map((v) => v.toFixed(2)).join(', ')})`,
  );
  console.log(`  開探針：右 ${show(out.withProbes.right)}、左 ${show(out.withProbes.left)}`);
  console.log(
    `  開探針：後 ${show(out.withProbes.back)}（該是黃色 —— 這一點的反射方向 z 為負，走的是八面體的折疊分支）`,
  );
  console.log(`  關探針：右 ${show(out.without.right)}、左 ${show(out.without.left)}`);

  const inFrame = (uv) => uv[0] > 0.02 && uv[0] < 0.98 && uv[1] > 0.02 && uv[1] < 0.98;
  check(
    Object.values(out.screen).every(inFrame),
    `四個取樣點都在畫面裡 —— ${Object.entries(out.screen)
      .map(([k, v]) => k + ' (' + v.map((n) => n.toFixed(2)).join(', ') + ')')
      .join('、')}`,
  );
  check(
    out.info.written === out.info.probes,
    `每顆探針都寫進圖集了 —— ${out.info.written}/${out.info.probes} 塊`,
  );

  const right = dominant(out.withProbes.right);
  const left = dominant(out.withProbes.left);
  console.log(
    `  主導通道：右 ${right.channel}（比第二強的高 ${right.ratio.toFixed(1)} 倍）、左 ${left.channel}（${left.ratio.toFixed(1)} 倍）`,
  );

  // ## 判準是「哪個通道最強」，不是絕對亮度
  //
  // 絕對值取決於牆佔了那顆探針多少立體角、八面體圖塊多大、有沒有混到地板 ——
  // 全都不是這裡要測的。要測的是**方向對不對**。
  check(
    right.channel === 'R' && right.ratio > 3,
    `地板偏 +x 那一塊照出紅牆 —— ${show(out.withProbes.right)}`,
  );
  check(
    left.channel === 'B' && left.ratio > 3,
    `地板偏 −x 那一塊照出藍牆 —— ${show(out.withProbes.left)}`,
  );

  // 黃 = 紅綠都亮、藍很暗。`dominant` 只答得出單一通道，而黃色的紅綠是
  // 平手的，所以這一條自己判。
  const back = out.withProbes.back;
  check(
    Math.min(back[0], back[1]) > 0.3 && Math.min(back[0], back[1]) > back[2] * 5,
    `地板偏 −z 那一塊照出黃牆 —— ${show(back)}（折疊那一段對得上 CPU）`,
  );

  const brightness = (rgb) => rgb[0] + rgb[1] + rgb[2];
  check(
    brightness(out.without.right) < brightness(out.withProbes.right) * 0.1,
    `關掉探針就只剩寫死的天空色 —— ${show(out.without.right)} 對 ${show(out.withProbes.right)}`,
  );

  // ---- 串流 ----
  console.log(
    `  串流：牆現身但不通知 → ${show(out.revealedNoInvalidate)}（過期 ${out.staleAfterReveal} 顆）`,
  );
  console.log(`  串流：通知 ${out.marked} 顆並重烘 → ${show(out.revealedInvalidated)}`);

  check(
    out.staleAfterReveal === 0,
    `沒人通知的話探針不知道世界變了 —— 過期 ${out.staleAfterReveal} 顆`,
  );
  check(
    out.revealedNoInvalidate[1] < 0.05,
    `所以那面牆照不進反射裡 —— 綠色只有 ${out.revealedNoInvalidate[1].toFixed(4)}`,
  );
  check(out.marked > 0, `invalidateAround 標了 ${out.marked} 顆探針`);
  const front = dominant(out.revealedInvalidated);
  check(
    front.channel === 'G' && out.revealedInvalidated[1] > out.revealedNoInvalidate[1] * 5,
    `通知並重烘之後牆進到反射裡了 —— 綠色 ${out.revealedNoInvalidate[1].toFixed(4)} → ${out.revealedInvalidated[1].toFixed(4)}`,
  );
} catch (error) {
  console.log('  ✗ ' + String(error?.message ?? error));
  markFailed();
} finally {
  await browser.close();
  site.close();
}

finish('反射探針關卡');
