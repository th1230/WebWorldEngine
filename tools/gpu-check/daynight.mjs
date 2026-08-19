/**
 * 太陽移動的代價：整份探針重烘要多久。
 *
 * ## 為什麼這是架構問題而不是功能
 *
 * 現在的探針是**烘出來的**。`invalidateAround` 處理「東西移動」——影響的是
 * 附近那十幾顆。但太陽移動影響的是**每一顆**：幾何沒變，收到的光全變了。
 *
 * 如果整份重烘夠便宜，答案就是「分幀重烘」，而那套機制（過期佇列、預算、
 * 逐顆推進）已經在了 —— 幾乎不用寫東西。
 *
 * 如果不夠便宜，就得換架構：把**看得見什麼**（幾何、反照率）與**收到多少光**
 * 分開存，光變的時候只重算後者，不重新擷取場景。那是表面快取的想法，而這個
 * 專案已經在別的地方用過它。
 *
 * 這支工具就是量那個分岔點。先量再決定，不要先猜。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
import { listenSafe } from '../lib/listen-safe.mjs';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = join(root, 'apps/example/dist');
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (path === '/favicon.ico') { res.writeHead(204).end(); return; }
  const file = join(DIST, path === '/' ? 'index.html' : path);
  readFile(file).then(
    (b) => { res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }[extname(file)] ?? 'application/octet-stream' }); res.end(b); },
    () => res.writeHead(404).end(),
  );
});
await listenSafe(server);

console.log('太陽移動的代價：整份探針重烘要多久\n');
let failed = 0;
const check = (ok, message) => {
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + message);
  if (!ok) failed++;
};
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const base = `http://localhost:${server.address().port}`;

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultNavigationTimeout(240000);
  await page.goto(`${base}/?gi=1&verify=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ww?.gi != null, undefined, { timeout: 120000 });

  const out = await page.evaluate(async () => {
    const gi = window.__ww.gi;
    // 先烘到收斂。
    let guard = 0;
    while (gi.stats().baked < gi.stats().probes && guard++ < 500) await gi.bake();

    const probes = gi.stats().probes;

    // 太陽動了：每一顆都過期。
    const marked = gi.invalidateAll();

    // 量整份重烘。每一輪記一次時間，這樣看得出是不是分批的。
    const rounds = [];
    const started = performance.now();
    guard = 0;
    while (gi.stats().stale > 0 && guard++ < 2000) {
      const t0 = performance.now();
      const n = await gi.bake();
      rounds.push({ ms: performance.now() - t0, probes: n });
    }
    const totalMs = performance.now() - started;

    return { probes, marked, totalMs, rounds };
  });
  await page.close();

  const perProbe = out.totalMs / Math.max(out.marked, 1);
  const roundMs = out.rounds.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = roundMs[roundMs.length >> 1] ?? 0;

  console.log(`  探針 ${out.probes} 顆，太陽一動全部過期（標了 ${out.marked} 顆）`);
  console.log(`  整份重烘 **${out.totalMs.toFixed(0)} ms**，分 ${out.rounds.length} 輪，每輪中位數 ${p50.toFixed(1)} ms`);
  console.log(`  攤下來每顆 ${perProbe.toFixed(2)} ms\n`);

  // 一個日夜循環十分鐘的話，太陽每秒走 0.6 度。探針要多久才跟得上？
  for (const budget of [2, 4, 8]) {
    const frames = out.totalMs / budget;
    const seconds = frames / 60;
    console.log(`  每幀給 ${budget} ms 的話：要 ${Math.round(frames)} 幀 ≈ ${seconds.toFixed(1)} 秒才追得上一次太陽移動`);
  }

  console.log('');
  const catchUpSeconds = out.totalMs / 4 / 60;
  console.log(
    catchUpSeconds < 2
      ? '  → 分幀重烘就夠了：追得上，機制也已經在了。'
      : `  → **分幀重烘追不上**（${catchUpSeconds.toFixed(1)} 秒才轉一輪）。要換架構：把「看得見什麼」與「收到多少光」分開存。`,
  );
  // ## 真正要問的不是「整份要多久」，是「每幀付多少」
  //
  // 693 ms 裡面**大部分是在等 GPU**，而等待是非同步的、不佔主執行緒。
  // 拿總時間去除以預算會嚴重高估。
  //
  // 所以直接量：一邊持續重烘一邊跑，幀時間有沒有變差。交錯做 A/B，因為
  // 這台機器的幀時間是雙峰的。
  console.log("");
  console.log('── 持續重烘的實際代價（交錯 A/B）');
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page2.setDefaultNavigationTimeout(240000);
  await page2.goto(`${base}/?gi=1&verify=1`, { waitUntil: "load" });
  await page2.waitForFunction(() => window.__ww?.gi != null, undefined, { timeout: 120000 });

  const ab = await page2.evaluate(async () => {
    const gi = window.__ww.gi;
    let guard = 0;
    while (gi.stats().baked < gi.stats().probes && guard++ < 500) await gi.bake();

    const samples = [];
    let seed = 0x9e3779b9;
    const roll = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % 100;
    };

    let last = 0;
    for (let frame = 0; frame < 600; frame++) {
      const now = await new Promise((resolve) => requestAnimationFrame(resolve));
      // 太陽一直在動：每一幀都讓整份過期，模擬最壞情況。
      gi.invalidateAll();
      const baking = roll() < 50;
      const t0 = performance.now();
      if (baking) await gi.bake();
      const cost = performance.now() - t0;
      if (last > 0) samples.push({ frameMs: now - last, baking, cost });
      last = now;
    }
    return samples;
  });
  await page2.close();

  // 幀間隔量的是「這一幀之前那一段」，所以工作要往後挪一格配對。
  const rows = ab.slice(1).map((x, i) => ({ ...ab[i], frameMs: x.frameMs })).slice(30);
  const mid = (xs, f) => { if (xs.length === 0) return 0; const v = xs.map(f).sort((a, b) => a - b); return v[v.length >> 1]; };
  const on = rows.filter((r) => r.baking);
  const off = rows.filter((r) => !r.baking);
  console.log(`  有烘的 ${on.length} 幀，沒烘的 ${off.length} 幀`);
  console.log(`    有烘   幀 ${mid(on, (r) => r.frameMs).toFixed(2)} ms   其中 bake() 佔用主執行緒 ${mid(on, (r) => r.cost).toFixed(2)} ms`);
  console.log(`    沒烘   幀 ${mid(off, (r) => r.frameMs).toFixed(2)} ms`);
  const delta = mid(on, (r) => r.frameMs) - mid(off, (r) => r.frameMs);
  console.log(`    **每幀多付 ${delta.toFixed(2)} ms**`);
  console.log(
    delta < 3
      ? '  → 撐得住：現在的烘焙架構就能跟著太陽走，不必換。'
      : '  → 撐不住：要把「看得見什麼」與「收到多少光」分開存。',
  );

  // ## 關鍵幀那條路：真的跟著太陽走嗎，而且真的便宜嗎
  //
  // 上面證明了重烘撐不住。這一段驗替代方案：兩個太陽角度各烘一份，
  // 執行期內插。要過的條件有三個 —— 內插得出不同的光、中間值在兩端之間、
  // 而且每幀的代價要遠低於重烘的 12.1 ms。
  console.log("");
  console.log('── 關鍵幀那條路（先烘兩個角度，執行期內插）');
  const page3 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page3.setDefaultNavigationTimeout(240000);
  await page3.goto(`${base}/?gi=1&verify=1`, { waitUntil: "load" });
  await page3.waitForFunction(() => window.__ww?.gi != null, undefined, { timeout: 120000 });

  const kf = await page3.evaluate(async () => {
    const gi = window.__ww.gi;
    const bakeAll = async () => {
      let guard = 0;
      while (guard++ < 3000) {
        const st = gi.stats();
        if (st.baked >= st.probes && st.stale === 0) break;
        await gi.bake();
      }
    };

    // 太陽在一邊，烘一份。
    gi.setSun(0);
    await bakeAll();
    gi.saveKeyframe(0);
    const at = [0, 6, 0];
    const n = [0, 1, 0];
    gi.setPhase(0);
    const early = gi.sampleCpu(at, n);

    // 太陽在另一邊，再烘一份。
    gi.setSun(1);
    await bakeAll();
    gi.saveKeyframe(1);
    gi.setPhase(1);
    const late = gi.sampleCpu(at, n);

    gi.setPhase(0.5);
    const mid = gi.sampleCpu(at, n);

    // 每幀改相位的代價 —— 交錯 A/B。
    const samples = [];
    let seed = 0x85ebca6b;
    const roll = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % 100; };
    let last = 0;
    for (let frame = 0; frame < 400; frame++) {
      const now = await new Promise((resolve) => requestAnimationFrame(resolve));
      const changing = roll() < 50;
      const t0 = performance.now();
      if (changing) gi.setPhase((frame % 100) / 100);
      const cost = performance.now() - t0;
      if (last > 0) samples.push({ frameMs: now - last, changing, cost });
      last = now;
    }

    return { keyframes: gi.keyframes(), early, late, mid, samples };
  });
  await page3.close();

  const kfRows = kf.samples.slice(1).map((x, i) => ({ ...kf.samples[i], frameMs: x.frameMs })).slice(30);
  const mid2 = (xs, f) => { if (xs.length === 0) return 0; const v = xs.map(f).sort((a, b) => a - b); return v[v.length >> 1]; };
  const kfOn = kfRows.filter((r) => r.changing);
  const kfOff = kfRows.filter((r) => !r.changing);

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const spread = dist(kf.early, kf.late);
  const toEarly = dist(kf.mid, kf.early);
  const toLate = dist(kf.mid, kf.late);

  console.log(`  關鍵幀 ${kf.keyframes} 份`);
  console.log(`    相位 0   輻照度 ${kf.early.map((v) => v.toFixed(3)).join(", ")}`);
  console.log(`    相位 1   輻照度 ${kf.late.map((v) => v.toFixed(3)).join(", ")}`);
  console.log(`    相位 0.5 輻照度 ${kf.mid.map((v) => v.toFixed(3)).join(", ")}`);
  console.log(`    兩端差距 ${spread.toFixed(4)}，中間到兩端 ${toEarly.toFixed(4)} / ${toLate.toFixed(4)}`);
  console.log(`    改相位的幀 ${mid2(kfOn, (r) => r.frameMs).toFixed(2)} ms（主執行緒 ${mid2(kfOn, (r) => r.cost).toFixed(2)} ms），沒改的 ${mid2(kfOff, (r) => r.frameMs).toFixed(2)} ms`);

  const perFrame = mid2(kfOn, (r) => r.frameMs) - mid2(kfOff, (r) => r.frameMs);
  check(kf.keyframes === 2, `兩份關鍵幀都存起來了 —— ${kf.keyframes}`);
  check(spread > 0.02, `太陽角度不同真的烘出不同的間接光 —— 差距 ${spread.toFixed(4)}`);
  check(
    toEarly < spread && toLate < spread,
    `中間的相位落在兩端之間 —— ${toEarly.toFixed(4)} / ${toLate.toFixed(4)} 都小於 ${spread.toFixed(4)}`,
  );
  check(perFrame < 3, `每幀代價遠低於重烘 —— 多付 ${perFrame.toFixed(2)} ms（重烘是 12.1 ms）`);

} catch (e) {
  console.log('失敗：' + String(e).split(String.fromCharCode(10))[0].slice(0, 220));
  process.exitCode = 1;
}
await browser.close();
server.close();

if (failed > 0) {
  console.log(``);
  console.log(`日夜循環關卡：${failed} 項沒過`);
  process.exit(1);
}
if (process.exitCode) {
  console.log(``);
  console.log(`日夜循環關卡：掛了，沒跑完`);
  process.exit(1);
}
console.log(``);
console.log(`日夜循環關卡：全過`);