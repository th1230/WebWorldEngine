/**
 * 串流時那幾幀慢在哪裡。
 *
 * ## 為什麼要問這一題
 *
 * 空間分割那一輪之後留下 p50 9.55 ms 對 p95 22.41 ms，而當時的註記是
 * 「剩下的 p95 不是重建了 —— 是載入本身（建幾何、上傳）。那是另一件事」。
 *
 * 然後就擱著了。而「建幾何」與「上傳」是**兩件不同的事，解法也不同**：
 * 前者要把工作分攤到多幀，後者要換上傳的方式（或改成分頁上傳 —— 那正是
 * 虛擬貼圖那一類做法在解的東西）。分不開就只能猜，而這個專案已經有過兩次
 * 「猜錯兩次才想到要拆開量」的紀錄（探針烘焙那 38.81 ms）。
 *
 * ## 怎麼拆
 *
 * 載入回呼自己的時間（產生矩陣 + 呼叫 place）是直接量得到的。整幀的時間也是。
 * **差額就是下游** —— 寫進批次、上傳到 GPU、重建那些。兩邊都有數字之後，
 * 「要分攤什麼」就不必猜了。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
import { listenSafe } from '../lib/listen-safe.mjs';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = join(root, 'apps/example/dist');
const COOKED = join(root, 'apps/benchmark/public');
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (path === '/favicon.ico') { res.writeHead(204).end(); return; }
  const file = path.startsWith('/cooked') ? join(COOKED, path) : join(DIST, path === '/' ? 'index.html' : path);
  readFile(file).then(
    (b) => { res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' }[extname(file)] ?? 'application/octet-stream' }); res.end(b); },
    () => res.writeHead(404).end(),
  );
});
await listenSafe(server);

console.log('串流時那幾幀慢在哪裡：回呼、還是下游\n');
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const base = `http://localhost:${server.address().port}`;

// ## 相機要真的走，否則量不到串流
//
// 第一次跑只有 11/599 幀有 cell 進來 —— 相機繞的圈太小（半徑 260，
// 角速度 0.12，也就是每秒 31 個單位，而一格是 120）。那不是串流壓力，
// 那是「偶爾載一格」。
//
// 所以掃描圈的半徑：半徑越大線速度越快，工作集換得越勤。
const SPEEDS = [
  ['慢（每秒 31 單位）', 260],
  ['中（每秒 240 單位）', 2000],
  ['快（每秒 600 單位）', 5000],
  ['極快（每秒 1440 單位）', 12000],
];

try {
  for (const [label, orbit] of SPEEDS) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultNavigationTimeout(240000);
  await page.goto(`${base}/?stream=1&count=200000&orbit=${orbit}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ww?.totalFrames > 120, undefined, { timeout: 240000 });

  const measured = await page.evaluate(async () => {
    // ## 誰把主執行緒佔住了
    //
    // 尖峰幀裡我們自己的回呼反而更短，而幀卻更長 —— 也就是說時間花在
    // **rAF 回呼之外**。long task 觀察器就是問這個問題的標準工具：它報
    // 每一段超過 50 ms 的封鎖，以及那段時間歸誰。
    const longTasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({
          duration: entry.duration,
          name: entry.name,
          attribution: (entry.attribution ?? []).map((a) => a.name + ":" + a.containerType).join(","),
        });
      }
    });
    try {
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      // 不支援就算了 —— 其餘的量測不靠它。
    }
    window.__ww.streamProbe.start();
    // 相機一直在繞，所以只要等就會一直有 cell 進出。600 幀約十秒。
    await new Promise((resolve) => {
      let n = 0;
      const tick = () => (++n < 600 ? requestAnimationFrame(tick) : resolve());
      requestAnimationFrame(tick);
    });
    observer.disconnect();
    return { samples: window.__ww.streamProbe.stop(), longTasks };
  });
  await page.close();
  const out = measured.samples;
  const longTasks = measured.longTasks;

  if (out.length === 0) throw new Error('沒有取到樣本');

  // ## 幀間隔與回呼要錯開一格配對
  //
  // rAF 的 `time` 是**這一幀開始**的時刻，所以 `frameMs = time(N) - time(N-1)`
  // 量的是「第 N 次回呼之前那一段」。而第 N 筆記下來的回呼時間與引擎分項，
  // 描述的是第 N 次回呼**自己**。
  //
  // 兩者差一格。直接配在一起的話，一個很慢的回呼會把**下一筆**的 frameMs
  // 撐大，於是看起來像「慢的那幾幀回呼反而比較短」—— 而我確實得到過那個
  // 結論，還把它寫進 roadmap。是 CDP 的 trace 打臉才發現的。
  //
  // 這裡把工作量往後挪一格：第 N-1 次回呼做的事，配第 N 筆的間隔。
  const shifted = out
    .slice(1)
    .map((sample, i) => ({ ...out[i], frameMs: sample.frameMs }))
    // 前 60 幀是暖機（分頁剛回到前景、著色器還在編、HLOD 還沒烘完），丟掉。
    .slice(60);

  // ## 用中位數，不用平均
  //
  // 實測有一次量到單一 1004 ms 的樣本（分頁排程的一次性打嗝），而它一個人
  // 就把平均整個帶走 —— 同一個設定前一次跑還是乾淨的。一個會因為一顆離群
  // 值就翻掉的統計量，等於一個會隨機紅的關卡（doctrine 第 17 條）。
  const mid = (xs, f) => {
    if (xs.length === 0) return 0;
    const sortedValues = xs.map(f).sort((a, b) => a - b);
    return sortedValues[sortedValues.length >> 1];
  };
  console.log(`── ${label}`);

  const sorted = shifted.map((s) => s.frameMs).sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const p50 = p(0.5);
  const p95 = p(0.95);

  // 慢的那幾幀 = 超過 p95 的。它們有沒有在載入？載入的那一段佔多少？
  const spikes = shifted.filter((s) => s.frameMs >= p95);
  const withLoad = spikes.filter((s) => s.cells > 0);
  const quiet = shifted.filter((s) => s.cells === 0);
  const loading = shifted.filter((s) => s.cells > 0);


  console.log(`  取樣 ${shifted.length} 幀，其中 ${loading.length} 幀有 cell 進來`);
  console.log(`  幀 p50 ${p50.toFixed(2)} ms   p95 ${p95.toFixed(2)} ms   最慢 ${sorted[sorted.length - 1].toFixed(2)} ms\n`);

  console.log('  沒載入的幀 vs 有載入的幀');
  console.log(`    沒載入  ${mid(quiet, (s) => s.frameMs).toFixed(2)} ms（${quiet.length} 幀）`);
  console.log(`    有載入  ${mid(loading, (s) => s.frameMs).toFixed(2)} ms（${loading.length} 幀）`);
  console.log(`    其中回呼自己 ${mid(loading, (s) => s.loadMs).toFixed(2)} ms，平均放 ${Math.round(mid(loading, (s) => s.placed)).toLocaleString()} 個\n`);

  console.log(`  最慢的那 ${spikes.length} 幀（≥ p95）`);
  console.log(`    其中 ${withLoad.length} 幀正在載入（${((withLoad.length / Math.max(spikes.length, 1)) * 100).toFixed(0)}%）`);
  console.log(`    平均整幀 ${mid(spikes, (s) => s.frameMs).toFixed(2)} ms，回呼自己 ${mid(spikes, (s) => s.loadMs).toFixed(2)} ms`);

  const spikeFrame = mid(spikes, (s) => s.frameMs);
  const spikeLoad = mid(spikes, (s) => s.loadMs);
  const share = (spikeLoad / Math.max(spikeFrame, 1e-6)) * 100;
  console.log(`    **回呼佔尖峰的 ${share.toFixed(1)}%，其餘 ${(100 - share).toFixed(1)}% 在下游**\n`);

  if (longTasks.length > 0) {
    const total = longTasks.reduce((a, b) => a + b.duration, 0);
    const worst = longTasks.slice().sort((a, b) => b.duration - a.duration)[0];
    console.log(`  長任務（>50 ms 的封鎖）：${longTasks.length} 次，共 ${total.toFixed(0)} ms，最長 ${worst.duration.toFixed(0)} ms`);
    console.log(`    歸屬：${worst.attribution || worst.name || "（沒有歸屬資訊）"}`);
  } else {
    console.log('  長任務：0 次 —— 沒有單一一段超過 50 ms 的封鎖，尖峰是很多段中等的累積。');
  }
  console.log("");

  // ## 尖峰跟哪一個分項一起動
  //
  // 引擎自己就報 grid／bake／HLOD 分組與烘焙的時間。尖峰幀與安靜幀各取
  // 平均一比，差最多的那一項就是兇手 —— 不必猜，也不必翻程式碼。
  const PARTS = [
    ['引擎 CPU（剔除等）', (x) => x.cpuMs],
    ['空間格重建', (x) => x.grid],
    ['HLOD 分組', (x) => x.hlodBuild],
    ['HLOD 合併', (x) => x.hlodMerge],
    ['HLOD 上傳', (x) => x.hlodUpload],
    ['LOD 烘焙', (x) => x.bake],
    ['送繪製指令（主執行緒）', (x) => x.renderMs],
    ['整個 rAF 回呼', (x) => x.tickMs],
    ['瀏覽器擋住的（幀 − 回呼）', (x) => x.frameMs - x.tickMs],
  ];
  console.log(`  尖峰幀 vs 安靜幀，各分項的平均`);
  let worst = null;
  for (const [name, f] of PARTS) {
    const hot = mid(spikes, f);
    const cold = mid(quiet, f);
    const delta = hot - cold;
    if (worst === null || delta > worst.delta) worst = { name, delta, hot, cold };
    console.log(`    ${name.padEnd(20)} 尖峰 ${hot.toFixed(2)} ms   安靜 ${cold.toFixed(2)} ms   差 ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} ms`);
  }
  if (worst !== null) {
    const explained = (worst.delta / Math.max(mid(spikes, (x) => x.frameMs) - mid(quiet, (x) => x.frameMs), 1e-6)) * 100;
    console.log(`    **差最多的是「${worst.name}」，解釋了尖峰增量的 ${explained.toFixed(0)}%**`);
    if (explained < 40) {
      console.log('    → 沒有一個分項解釋得了：尖峰在引擎量不到的地方（Three 自己的上傳／繪製）。');
    }
  }
  console.log("");

  // ## 尖峰幀是不是單純「畫的東西比較多」
  //
  // 我們自己的回呼在尖峰幀反而更短，又沒有任何長任務 —— 那個組合指向
  // GPU：rAF 是被呈現節奏帶的，畫得久幀就長。要證實它，看尖峰幀是不是
  // 真的有比較多東西被畫出來。
  const hotVis = mid(spikes, (x) => x.visible);
  const coldVis = mid(quiet, (x) => x.visible);
  const hotTri = mid(spikes, (x) => x.triangles);
  const coldTri = mid(quiet, (x) => x.triangles);
  console.log(`  畫的東西：尖峰 ${Math.round(hotVis).toLocaleString()} 個可見 / ${Math.round(hotTri).toLocaleString()} 三角形`);
  console.log(`            安靜 ${Math.round(coldVis).toLocaleString()} 個可見 / ${Math.round(coldTri).toLocaleString()} 三角形`);
  const triRatio = hotTri / Math.max(coldTri, 1);
  console.log(
    triRatio > 1.3
      ? `    → 尖峰幀真的比較重（三角形 ${triRatio.toFixed(2)}×）：這是 GPU，不是上傳。`
      : `    → 尖峰幀畫的東西**沒有比較多**（${triRatio.toFixed(2)}×）：GPU 負載一樣，時間花在別處。`,
  );
  console.log("");

  // ## 每格的下游成本是穩定的、還是偶爾很貴
  //
  // 這個差別決定解法：**穩定的**代表寫入本身就是那個價錢，要把一格拆小；
  // **偶爾很貴**代表有別的東西被觸發（緩衝區重配、批次重建），要去掉那件事。
  const quietBase = mid(quiet, (s) => s.frameMs) || p50;
  const perCell = loading
    .filter((s) => s.cells > 0)
    .map((s) => (s.frameMs - quietBase - s.loadMs) / s.cells)
    .sort((a, b) => a - b);
  if (perCell.length > 0) {
    const q = (f) => perCell[Math.min(perCell.length - 1, Math.floor(perCell.length * f))];
    console.log(`  每格的下游成本：p50 ${q(0.5).toFixed(2)} ms   p95 ${q(0.95).toFixed(2)} ms   最貴 ${perCell[perCell.length - 1].toFixed(2)} ms`);
    const ratio = q(0.95) / Math.max(q(0.5), 0.01);
    console.log(
      ratio > 4
        ? '    → 偶爾很貴（p95 是 p50 的 ' + ratio.toFixed(1) + ' 倍）：有東西被觸發，不是寫入本身的價錢。'
        : '    → 穩定（p95 是 p50 的 ' + ratio.toFixed(1) + ' 倍）：就是寫入本身的價錢，要把一格拆小。',
    );
    console.log(`    每格 ${Math.round(mid(loading, (s) => s.placed) / Math.max(mid(loading, (s) => s.cells), 1))} 個 instance
`);
  }

  if (withLoad.length / Math.max(spikes.length, 1) < 0.5) {
    console.log('  → 尖峰**不是**載入造成的：慢的那幾幀多數沒有 cell 進來。');
  } else if (share > 50) {
    console.log('  → 尖峰在**回呼自己**（產生內容）。解法是把產生分攤到多幀。');
  } else {
    console.log('  → 尖峰在**下游**（寫入批次／上傳／重建）。解法是分攤上傳，不是分攤產生。');
  }
  }
} catch (e) {
  console.log('失敗：' + String(e).split('\n')[0].slice(0, 200));
  process.exitCode = 1;
}
// ## 因果測試：只重寫緩衝，內容完全不動
//
// 上面量到的是相關：cell 進來的那幾幀比較慢。但「同樣的三角形、更少的 JS、
// 沒有長任務，而下一次 rAF 被押後」只是指向驅動同步 —— 那是推論。
//
// 這裡把它變成因果：場景靜止（沒有串流），只是每 N 幀把一批矩陣**用同樣的
// 值再寫一次**。畫面一模一樣、JS 幾乎沒變，唯一多出來的就是那次緩衝改寫。
try {
  console.log("");
  console.log('── 因果測試：靜止的場景，交錯地重寫矩陣（約一半的幀）');
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultNavigationTimeout(240000);
  // ## 條件要與串流時一致，否則量不到
  //
  // 第一版用 60,000 個密集擺放 —— 那個場景本身就 30 ms（GPU 綁住），而一個
  // 20 ms 的 CPU 停頓會**整個藏在後面**。量出來「沒有變慢」是必然的，不是
  // 證據。
  //
  // 串流時的條件是：緩衝**容量很大**（200,000），但真正畫出來的很少（多數
  // 被剔掉），每次只改一格的量（400 個）。攤得很開就重現得出來。
  await page.goto(`${base}/?count=200000&spread=8000&orbit=200&rewrite=50&rewriteCount=400`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ww?.totalFrames > 120, undefined, { timeout: 240000 });

  const out = await page.evaluate(async () => {
    window.__ww.streamProbe.start();
    await new Promise((resolve) => {
      let n = 0;
      const tick = () => (++n < 600 ? requestAnimationFrame(tick) : resolve());
      requestAnimationFrame(tick);
    });
    return window.__ww.streamProbe.stop();
  });
  await page.close();

  const mid = (xs, f) => { if (xs.length === 0) return 0; const v = xs.map(f).sort((a, b) => a - b); return v[v.length >> 1]; };
  const wrote = out.filter((x) => x.rewrote);
  const didnt = out.filter((x) => !x.rewrote);
  console.log(`  重寫的那幾幀 ${wrote.length}，沒重寫的 ${didnt.length}`);
  console.log(`    重寫幀   幀 ${mid(wrote, (x) => x.frameMs).toFixed(2)} ms   其中寫矩陣本身 ${mid(wrote, (x) => x.rewriteMs).toFixed(2)} ms`);
  console.log(`    沒重寫   幀 ${mid(didnt, (x) => x.frameMs).toFixed(2)} ms`);
  console.log(`    三角形   重寫 ${Math.round(mid(wrote, (x) => x.triangles)).toLocaleString()}   沒重寫 ${Math.round(mid(didnt, (x) => x.triangles)).toLocaleString()}`);
  const delta = mid(wrote, (x) => x.frameMs) - mid(didnt, (x) => x.frameMs);
  const jsDelta = mid(wrote, (x) => x.rewriteMs);
  console.log(`    **多出來 ${delta.toFixed(2)} ms，其中 JS 只佔 ${jsDelta.toFixed(2)} ms**`);
  console.log(
    delta > jsDelta * 2 + 2
      ? '  → 因果成立：內容完全沒變，只是重寫緩衝就變慢了，而且慢的不是 JS。'
      : '  → 因果不成立：重寫緩衝本身不貴，尖峰的原因在別處。',
  );
} catch (e) {
  console.log("因果測試失敗：" + String(e).split(String.fromCharCode(10))[0].slice(0, 200));
  process.exitCode = 1;
}

// ## 第二個因果測試：走真正的寫入路徑
//
// 上一個用 setMatrixAt，量不到成本 —— 但串流走的不是那條路。它走
// writeMatrices，而那一支除了寫矩陣還會重算區塊表、推一個 HLOD append。
// 也就是上一個實驗測錯了路徑：它證明的是「寫矩陣本身不貴」，而那本來就
// 不是串流做的全部。
try {
  console.log("");
  console.log('── 因果測試二：靜止的場景，交錯地走真正的寫入路徑（writeMatrices）');
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultNavigationTimeout(240000);
  await page.goto(`${base}/?count=200000&spread=8000&orbit=200&churn=50&churnCount=400`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ww?.totalFrames > 120, undefined, { timeout: 240000 });

  const out = await page.evaluate(async () => {
    window.__ww.streamProbe.start();
    await new Promise((resolve) => {
      let n = 0;
      const tick = () => (++n < 600 ? requestAnimationFrame(tick) : resolve());
      requestAnimationFrame(tick);
    });
    return window.__ww.streamProbe.stop();
  });
  await page.close();

  const mid = (xs, f) => { if (xs.length === 0) return 0; const v = xs.map(f).sort((a, b) => a - b); return v[v.length >> 1]; };
  const did = out.filter((x) => x.churned);
  const didnt = out.filter((x) => !x.churned);
  console.log(`  走了寫入路徑的 ${did.length} 幀，沒走的 ${didnt.length} 幀`);
  console.log(`    走了   幀 ${mid(did, (x) => x.frameMs).toFixed(2)} ms   其中 writeMatrices 本身 ${mid(did, (x) => x.churnMs).toFixed(2)} ms`);
  console.log(`    沒走   幀 ${mid(didnt, (x) => x.frameMs).toFixed(2)} ms`);
  console.log(`    三角形 走了 ${Math.round(mid(did, (x) => x.triangles)).toLocaleString()}   沒走 ${Math.round(mid(didnt, (x) => x.triangles)).toLocaleString()}`);
  console.log(`    引擎 CPU 走了 ${mid(did, (x) => x.cpuMs).toFixed(2)} ms   沒走 ${mid(didnt, (x) => x.cpuMs).toFixed(2)} ms`);
  console.log(`    HLOD 合併 走了 ${mid(did, (x) => x.hlodMerge).toFixed(2)} ms   沒走 ${mid(didnt, (x) => x.hlodMerge).toFixed(2)} ms`);
  const delta = mid(did, (x) => x.frameMs) - mid(didnt, (x) => x.frameMs);
  const jsDelta = mid(did, (x) => x.churnMs);
  console.log(`    **多出來 ${delta.toFixed(2)} ms，其中 writeMatrices 的同步部分只佔 ${jsDelta.toFixed(2)} ms**`);
  console.log(
    delta > 2
      ? '  → 因果成立：內容完全沒變，只是走一次真正的寫入路徑就變慢了。'
      : '  → 這條路徑也不是原因。',
  );
} catch (e) {
  console.log("因果測試二失敗：" + String(e).split(String.fromCharCode(10))[0].slice(0, 200));
  process.exitCode = 1;
}

await browser.close();
server.close();
