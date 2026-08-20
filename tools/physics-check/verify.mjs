/**
 * 物理與水的關卡：東西真的踩在畫出來的地面上、浮在畫出來的水面上。
 *
 * ## 為什麼這一關不能用單元測試代替
 *
 * `computeBuoyancy` 與 `buildHeightfield` 的單元測試驗的都是「這一刻算出
 * 來的數字對不對」，而這兩件事的錯法都**不在那個數字裡**：
 *
 * | 實際發生過的錯 | 每一幀的數字 | 症狀 |
 * | --- | --- | --- |
 * | 碰撞體密度沒設 | 完全正確 | 箱子 20 秒飛到 y = 183,996 |
 * | Rapier 的 addForce 是持續的 | 完全正確 | 第 N 幀的力是 N 倍，加速射向天空 |
 * | 高度場的列行順序反了 | 完全正確 | 箱子踩在看不見的地面上 |
 *
 * 三個都是**把時間跑過去**才看得到的。所以這一關真的開一個瀏覽器、真的跑
 * 900 步、然後問「箱子最後在哪裡」。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
import { listenSafe } from '../lib/listen-safe.mjs';
import { assertDistFresh } from '../lib/dist-fresh.mjs';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// 關卡吃的是建好的產物 —— 它比原始碼舊的話，這一輪的每個數字都沒有意義。
assertDistFresh(root);
const DIST = join(root, 'apps/example/dist');
const COOKED = join(root, 'apps/benchmark/public');

const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (path === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  const file = path.startsWith('/cooked')
    ? join(COOKED, path)
    : join(DIST, path === '/' ? 'index.html' : path);
  readFile(file).then(
    (b) => {
      res.writeHead(200, {
        'content-type':
          {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.json': 'application/json',
            '.wasm': 'application/wasm',
          }[extname(file)] ?? 'application/octet-stream',
      });
      res.end(b);
    },
    () => res.writeHead(404).end(),
  );
});
await listenSafe(server);

console.log('物理／水：跑 900 步，看箱子最後停在哪裡');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 800, height: 480 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().split('\n')[0]);
});
page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e.message).split('\n')[0]));

let failed = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  await page.goto(`http://localhost:${server.address().port}/?physics=1&orbit=260`, {
    waitUntil: 'load',
  });
  await page.waitForFunction(() => window.__ww?.totalFrames > 90, undefined, { timeout: 120000 });

  const out = await page.evaluate(async () => {
    const w = window.__ww;
    const seen = [];
    for (let i = 0; i < 900; i++) {
      w.step(i * 0.016);
      if (i % 150 === 0) seen.push(w.physics());
    }
    w.step(4);
    const info = w.renderer.info.render;
    return { seen, last: w.physics(), calls: info.calls, tri: info.triangles };
  });

  const s = out.last;
  console.log(
    '  逐段：',
    out.seen.map((x) => `啟用${x.active}/醒${x.awake}/睡${x.settled}/浮${x.floating}`).join('  '),
  );
  console.log(`  最後：${JSON.stringify(s)}`);
  console.log(`  ${out.calls} 次繪製，${out.tri.toLocaleString('en-US')} 三角形`);

  // 有東西真的浮著並且**停下來**。
  //
  // 只看 `floating`（這一幀受到浮力的數量）不夠 —— 那顆飛到 y = 183,996 的
  // 箱子在飛出去之前也算「浮著」。`afloatRest` 要求它停在水面附近而且明顯
  // 高於地表，射出去的與沉底的都不算。
  // ## 門檻是 10 不是 1
  //
  // 一開始這裡寫的是 `> 0`，而那個版本**在把 bug 放回去之後照樣過**：
  // 箱子全飛走了，剩下一顆恰好還在水面上，`> 0` 就滿足了。
  //
  // 過得了的關卡等於沒有關卡，比沒有更糟 —— 它還會給人「驗過了」的錯覺。
  // 正常是 34 顆，設 10 留得下雜訊的空間，又擋得住「只剩幾顆」。
  check(s.afloatRest >= 10, '有一批箱子停在水面上', `${s.afloatRest} 顆（正常約 34）`);
  check(s.floating >= 10, '有一批箱子受到浮力', `${s.floating} 顆`);

  // 沒有東西穿過地形。高度場的列行順序弄反的話這裡會炸。
  check(s.below === 0, '沒有箱子掉出地形', s.below === 0 ? undefined : `${s.below} 顆在地表下`);
  check(s.maxGap < 1, '箱子踩在畫出來的地面上，不是看不見的那個', `最大落差 ${s.maxGap}`);

  // ## 用峰值，不能用當下的高度
  //
  // 被射出去的箱子會飛出調度器的半徑然後被停用 —— 掃當下的剛體看不到它。
  // 而 `minY` 是**最低**的那顆，本來就不可能抓到往上飛的東西。
  //
  // 這兩個錯我都寫過：第一版拿 `minY` 當「有沒有飛上天」的證據，於是關卡
  // 在 bug 還在的情況下顯示全過。
  //
  // 箱子從 y = 40～70 落下，水位 −8，正常的峰值就是出生高度。
  check(s.peakY < 200, '沒有箱子被射到天上', `峰值 ${s.peakY}（出生約 40～70）`);

  // 調度器真的在停用遠處的東西，不是全部都在算。
  check(s.active > 0 && s.settled >= 0, '調度器有在運作', `啟用 ${s.active}`);

  check(out.calls > 0, '畫面真的畫出來了', `${out.calls} 次繪製`);
  check(errors.length === 0, '沒有主控台錯誤', errors.slice(0, 2).join(' | ') || undefined);
} catch (e) {
  console.log('  ✗ 失敗：' + String(e).split('\n')[0].slice(0, 120));
  failed++;
}

await page.close();
await browser.close();
server.close();

if (failed > 0) {
  console.log(`\n物理關卡：${failed} 項沒過`);
  process.exit(1);
}
console.log('\n物理關卡：全過');
