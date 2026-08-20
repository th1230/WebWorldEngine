/**
 * 幀是被 CPU 綁住還是被 GPU 綁住 —— 這決定 GPU 驅動繪製值不值得。
 *
 * GPU 驅動繪製要做的事是把剔除搬到 GPU 上。它能省的**上限**就是 CPU 那一段
 * ——而 CPU 與 GPU 是平行跑的，所以如果幀時間本來就等於 GPU 時間，那 CPU
 * 那一段是**藏在後面的**，搬走它一毫秒都省不到，反而多給已經是瓶頸的那一側
 * 加工作。
 *
 * 這不是代理量測（impostor 那次的錯是拿一個構不到的東西去逼近）。這裡量的
 * 是**上限本身**：省不到比 CPU 更多的時間，而 CPU 有多少是直接量得到的。
 */
import { join } from 'node:path';
import { assertDistFresh } from '../lib/dist-fresh.mjs';
import { serveDist } from '../lib/serve.mjs';
import { launchBrowser } from '../lib/browser.mjs';
import { ROOT } from '../lib/repo-root.mjs';

// 關卡吃的是建好的產物 —— 它比原始碼舊的話，這一輪的每個數字都沒有意義。
assertDistFresh(ROOT);
const DIST = join(ROOT, 'apps/example/dist');
const COOKED = join(ROOT, 'apps/benchmark/public');
const site = await serveDist(DIST, { mounts: { '/cooked': COOKED } });

// ## 常態場景，加上**刻意要把 CPU 逼成瓶頸**的那幾個
//
// 前三個是一般內容。後三個是在追那句「哪天幀時間開始等於 CPU 時間」——
// 那是先前不做 GPU 驅動繪製的翻盤條件，而一個**沒被跑過的翻盤條件**等於
// 沒有證據說它不會發生。所以這裡直接往那個方向推：物件數拉到二十萬、
// 攤得很開、相機只看得到一小塊 —— GPU 因為多數被剔掉而變輕，CPU 卻還是
// 要一個一個問過。那正是 GPU 驅動繪製最有話講的形狀。
const SCENES = [
  ['遠景・兩萬個', 'count=20000&spread=900&orbit=520'],
  ['遠景・六萬個', 'count=60000&spread=900&orbit=520'],
  ['貼地・六萬個', 'count=60000&spread=700&orbit=90'],
  ['廣・二十萬個（多數在視錐外）', 'count=200000&spread=4000&orbit=200'],
  ['廣・二十萬個（貼地近看）', 'count=200000&spread=2000&orbit=90'],
  ['密・二十萬個', 'count=200000&spread=900&orbit=520'],
];

console.log('幀被誰綁住：CPU 那一段搬得走的話，最多省多少\n');
const browser = await launchBrowser({ webgpu: true });
const base = site.origin;

const results = [];

try {
  for (const [label, query] of SCENES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultNavigationTimeout(240000);
    await page.goto(`${base}/?${query}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ww?.totalFrames > 60, undefined, { timeout: 240000 });

    const out = await page.evaluate(async () => {
      await window.__ww.settleHlod();

      // ## 幀時間要用 rAF 量，而且要在停掉迴圈之前
      //
      // 試過兩種都不行：
      //
      // - 直接量 `step()` 的耗時 —— 那只是**送指令**，不等 GPU 畫完。
      //   實測 0.5 ms，而同一個場景的 GPU 是 10 ms。
      // - 加 `gl.finish()` —— Chrome 的命令緩衝下它不是真的同步，數字沒動。
      //
      // rAF 量到的是**真的被呈現**的幀，那才是使用者感覺到的東西。代價是它
      // 被垂直同步夾住（約 16.7 ms），所以只有在 GPU 超過那條線的場景裡
      // 才看得出「誰綁住了幀」。
      const frames = await new Promise((resolve) => {
        const deltas = [];
        let last = performance.now();
        let n = 0;
        const tick = () => {
          const now = performance.now();
          deltas.push(now - last);
          last = now;
          if (++n < 90) requestAnimationFrame(tick);
          else resolve(deltas);
        };
        requestAnimationFrame(tick);
      });
      frames.sort((a, b) => a - b);

      const gpu = await window.__ww.measureGpuMs(0, 1200, 15);

      const cpu = [];
      for (let i = 0; i < 40; i++) {
        window.__ww.step(0);
        cpu.push(window.__ww.rocks.stats.cpuMs);
      }
      cpu.sort((a, b) => a - b);

      return {
        gpu: gpu.p50,
        frame: +frames[frames.length >> 1].toFixed(3),
        cpu: +cpu[cpu.length >> 1].toFixed(3),
        instances: window.__ww.rocks.count,
      };
    });
    await page.close();

    const ceiling = (out.cpu / out.frame) * 100;
    // 每個 instance 花多少 CPU —— 有了這個才能算「要幾個才翻得過來」。
    const perInstance = (out.cpu * 1e6) / Math.max(out.instances, 1);
    // 翻盤要 CPU 追上幀時間。照現在的每個成本，那要幾個 instance？
    const needed = Math.round(out.frame / (perInstance / 1e6));
    console.log(`  ${label}`);
    console.log(`    幀 ${out.frame} ms  GPU ${out.gpu} ms  剔除的 CPU ${out.cpu} ms`);
    console.log(
      `    ${out.instances.toLocaleString()} 個活著，每個 ${perInstance.toFixed(1)} ns —— CPU 要追上幀時間得有 ${needed.toLocaleString()} 個`,
    );
    console.log(`    **GPU 驅動繪製的上限：${ceiling.toFixed(1)}% 的幀時間**\n`);
    results.push({ label, ...out, ceiling, perInstance, needed });
  }
} catch (e) {
  console.log('失敗：' + String(e).split('\n')[0].slice(0, 160));
  process.exitCode = 1;
}
await browser.close();
site.close();

// ## 翻盤條件跑過了沒有
//
// 先前寫的是「哪天幀時間開始等於 CPU 時間，這條界就會抬起來」。上面後三個
// 場景就是往那個方向推的結果 —— 印出來的是**推到底之後最高的那個上限**。
const best = results.reduce(
  (a, b) => (b.ceiling > a.ceiling ? b : a),
  results[0] ?? { ceiling: 0, label: '（沒跑到）' },
);
if (results.length > 0) {
  console.log(`推到底：最高的上限是 ${best.ceiling.toFixed(1)}%（${best.label}）`);
  console.log(
    best.ceiling > 25
      ? '  → 翻盤條件成立了：CPU 開始構得到幀時間，GPU 驅動繪製要重新考慮。'
      : '  → 翻盤條件仍然不成立：CPU 還是藏在 GPU 後面。',
  );
}
