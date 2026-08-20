/**
 * 水的外觀：每一項都要從「水有多深」推得出來，而且與浮力用的是同一個水面。
 *
 * ## 場景
 *
 * 一個從深到淺的斜坡水底（z = −150 最深，z ≈ 90 露出水面成為沙灘），水底左右
 * 分成暗／亮兩半。相機站在沙灘上貼著水面斜看出去 —— 於是同一張畫面上同時有
 * 淺水與深水、接近正對與極度掠射。
 *
 * 平底的水池裡這些全是常數，量出來每個點都一樣。那不是效果沒用，是場景裡沒有
 * 那個變化。
 *
 * ## 判準
 *
 * | 主張 | 怎麼量 |
 * | --- | --- |
 * | 畫出來的水面就是浮力用的 | 著色器輸出世界座標，跟 CPU 的 `heightAt` 對答案 |
 * | 水色是吸收出來的 | 紅／藍的比值隨水深下降 |
 * | 岸邊有泡沫 | 泡沫隨水深單調衰減到 0 |
 * | 菲涅耳 | 掠射角的反射率遠高於正對 |
 * | 折射會扭曲水底 | 同一片水開關折射，水底那條直邊的彎曲程度 |
 * | 反射的是真的環境 | 水面反射出天空罩的紫紅，不是回退的綠 |
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

const { check, finish, fail } = startReport('水的外觀：每一項都要從水深推得出來');

/** 一串數字離「最小平方直線」有多遠。折射的彎曲就是這個殘差。 */
function residual(values) {
  const points = values.map((y, i) => [i, y]).filter(([, y]) => y >= 0);
  if (points.length < 4) return { count: points.length, rms: 0 };
  const n = points.length;
  const sx = points.reduce((a, [x]) => a + x, 0);
  const sy = points.reduce((a, [, y]) => a + y, 0);
  const sxx = points.reduce((a, [x]) => a + x * x, 0);
  const sxy = points.reduce((a, [x, y]) => a + x * y, 0);
  const slope = (n * sxy - sx * sy) / Math.max(n * sxx - sx * sx, 1e-9);
  const intercept = (sy - slope * sx) / n;
  const rms = Math.sqrt(
    points.reduce((a, [x, y]) => a + (y - (slope * x + intercept)) ** 2, 0) / n,
  );
  return { count: n, rms };
}

const browser = await launchBrowser({ webgpu: true });
const base = site.origin;
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
page.setDefaultNavigationTimeout(240000);

try {
  await page.goto(`${base}/?waterlook=1&verify=1`, { waitUntil: 'load' });
  try {
    await page.waitForFunction(() => window.__ww?.waterLook != null, undefined, { timeout: 60000 });
  } catch {
    const why = errors.length > 0 ? errors[0].slice(0, 300) : '（頁面沒有丟出任何錯誤）';
    throw new Error(`場景沒有建起來：${why}`);
  }

  const out = await page.evaluate(async () => {
    const api = window.__ww.waterLook;
    const baked = await api.settle();

    // 由近（淺、正對）到遠（深、掠射）。0.11 還在沙灘上。
    const rows = [0.13, 0.15, 0.18, 0.24, 0.32, 0.4, 0.46];
    const read = (mode, u) => {
      api.render(mode);
      return rows.map((v) => api.sample(u, v));
    };

    // 世界座標 → 跟 CPU 對答案。
    api.render(1);
    const world = rows.map((v) => api.sample(0.3, v));
    const cpu = world.map(([x, , z]) => api.heightAt(x, z));

    const depth = read(2, 0.3).map((c) => c[0]);
    const foam = read(3, 0.3).map((c) => c[0]);
    const fresnel = read(4, 0.3).map((c) => c[0]);
    // 折射後的顏色讀**亮的那半邊**：暗的那半邊水底本來就近乎全黑，
    // 吸收掉的東西太少，量到的幾乎只是散射色。
    const refracted = read(6, 0.7);
    const final = read(0, 0.3);

    // 折射的 A/B：同一片水，只改一個 uniform。
    api.setRefraction(0.05);
    api.render(0);
    const edgesOn = api.edges(48);
    api.setRefraction(0);
    api.render(0);
    const edgesOff = api.edges(48);
    api.setRefraction(0.05);

    return {
      baked,
      rows,
      world,
      cpu,
      depth,
      foam,
      fresnel,
      refracted,
      final,
      edgesOn,
      edgesOff,
      coverage: api.coverage(),
    };
  });

  const n = out.rows.length;
  console.log(`  烘了 ${out.baked} 顆探針`);
  console.log('  v      水面 y（GPU / CPU）      水深      泡沫    菲涅耳  折射後 R/B');
  for (let i = 0; i < n; i++) {
    const gpu = out.world[i][1];
    const ratio = out.refracted[i][0] / Math.max(out.refracted[i][2], 1e-6);
    console.log(
      `  ${String(out.rows[i]).padEnd(6)} ${gpu.toFixed(3).padStart(7)} / ${out.cpu[i].toFixed(3).padStart(7)}   ` +
        `${out.depth[i].toFixed(2).padStart(8)}  ${out.foam[i].toFixed(3).padStart(6)}  ${out.fresnel[i].toFixed(3).padStart(6)}  ${ratio.toFixed(3)}`,
    );
  }

  // ── 一、畫出來的水面就是浮力用的那一個 ──
  //
  // 這是整個 water.ts 存在的理由。兩邊各寫一份的話東西會浮在錯的高度，而
  // 那**不會報錯**，只是「看起來怪怪的」。
  const gaps = out.world.map((w, i) => Math.abs(w[1] - out.cpu[i]));
  const worst = Math.max(...gaps);
  check(
    worst < 0.05,
    `著色器畫的水面高度與 CPU 的 heightAt 一致 —— 最大差 ${worst.toFixed(4)} 公尺（振幅約 1 公尺）`,
  );

  // ── 二、水色是**吸收**出來的，不是塗上去的 ──
  //
  // 場景刻意讓水底與散射色都是中性灰，所以紅/藍會偏離 1 就只可能來自
  // 「紅的吸收係數比藍大」。
  //
  // 第一版的散射色是真實的藍綠，於是深處的紅/藍下降有一半是散射色給的 ——
  // 把三個通道的吸收改成同一個（完全不分波長）之後關卡照樣全綠。**判準
  // 借了另一個東西的力，就不是在測它自己那句話。**
  const ratios = out.refracted.map((c) => c[0] / Math.max(c[2], 1e-6));
  const lowest = Math.min(...ratios);
  console.log(`  折射後的紅/藍：${ratios.map((r) => r.toFixed(3)).join(' → ')}`);
  // 第一版斷言最淺處的紅/藍接近 1，實測是 0.762 —— 而那是對的：0.89 公尺的
  // 水就已經吃掉紅光的 27%。斷言錯了，不是效果錯了。改成量**梯度**。
  check(
    ratios[0] > lowest * 2.5,
    `同一片灰色的水底，越深紅掉得越多 —— 紅/藍 ${ratios[0].toFixed(3)} → ${lowest.toFixed(3)}`,
  );
  check(lowest < 0.4, `而水一深紅就先不見 —— 紅/藍 最低掉到 ${lowest.toFixed(3)}`);
  // 單調只在「水底還看得見」的那一段成立：再深下去水底被吸收光了，顏色
  // 收斂回散射色本身的比例（這個場景裡是 1）。
  const shallow = out.depth.map((d, i) => [d, ratios[i]]).filter(([d]) => d < 20);
  let monotonic = true;
  for (let i = 1; i < shallow.length; i++) {
    if (shallow[i][1] > shallow[i - 1][1] + 1e-3) monotonic = false;
  }
  check(
    shallow.length >= 4 && monotonic,
    `水底還看得見的那一段是單調的 —— ${shallow.map(([, r]) => r.toFixed(3)).join(' → ')}`,
  );
  // ── 三、岸邊的泡沫 ──
  check(
    out.foam[0] > 0.5 && out.foam[n - 1] < 0.02,
    `泡沫堆在岸邊 —— 水深 ${out.depth[0].toFixed(2)} 處是 ${out.foam[0].toFixed(3)}，水深 ${out.depth[n - 1].toFixed(0)} 處是 ${out.foam[n - 1].toFixed(3)}`,
  );

  // ── 四、菲涅耳 ──
  check(
    out.fresnel[n - 1] > out.fresnel[0] * 4,
    `掠射角反射得多得多 —— ${out.fresnel[0].toFixed(3)} → ${out.fresnel[n - 1].toFixed(3)}`,
  );

  // ── 五、折射把水底推歪 ──
  //
  // 直接看「邊界落在第幾行」不行：那條邊在畫面上本來就因為透視而斜，散布
  // 大部分是透視不是折射。所以看的是**離直線多遠**。
  const on = residual(out.edgesOn);
  const off = residual(out.edgesOff);
  console.log(
    `  水底那條直邊：開折射 ${on.count} 列、離直線 ${on.rms.toFixed(2)} 像素；關折射 ${off.count} 列、離直線 ${off.rms.toFixed(2)} 像素`,
  );
  check(on.count > 20 && off.count > 20, `兩組都抓得到那條邊 —— ${on.count} / ${off.count} 列`);
  // ## 判準是絕對值，不是比值
  //
  // 關掉折射時殘差是 **0.00** 像素 —— 一條世界空間的直線在透視投影下本來就
  // 還是直線，這是精確的。而 `on > off × 3` 在 off 是 0 的時候恆成立：
  // 折射壞掉只剩 0.01 像素，那條斷言照樣綠。
  check(off.rms < 0.1, `沒有折射時那條邊是直的 —— 離直線 ${off.rms.toFixed(3)} 像素`);
  check(on.rms > 0.5, `折射把它推歪了 —— 離直線 ${on.rms.toFixed(2)} 像素`);

  // ── 六、反射的是真的環境，不是回退色 ──
  //
  // 天空罩是紫紅（藍高、綠低），回退色是綠。最遠那一列幾乎全是反射。
  const far = out.final[n - 1];
  console.log(
    `  最遠那一列的顏色：${far.map((v) => v.toFixed(3)).join(' / ')}（天空罩紫紅、回退色綠）`,
  );
  check(
    far[2] > far[1] * 3,
    `水面反射的是天空罩不是回退色 —— 藍 ${far[2].toFixed(3)} 遠高於綠 ${far[1].toFixed(3)}`,
  );
} catch (error) {
  fail(String(error?.message ?? error));
} finally {
  await browser.close();
  site.close();
}

finish('水的外觀關卡');
