import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

/**
 * 畫面對不對，不是數字對不對。
 *
 * ## 為什麼非有這個不可
 *
 * 這個引擎每一種失效方式都**不會報錯**，而且大多數連數字都正常：
 *
 * | 犯過的錯 | `stats` 看得到嗎 |
 * | --- | --- |
 * | 包圍球過期，整個物件被剔掉 | ❌ 幀時間反而更好 |
 * | 遠景合併的槽位指到別組 | ❌ 數量、繪製次數全部正常 |
 * | 選階算錯，全部固定在第 0 階 | ❌ 只是慢一點 |
 * | 區塊半徑漏掉物件體積 | ❌ 只有某些角度少一叢 |
 *
 * `apps/example` 早就有 `__ww.verifyQuality()`，但**沒有任何東西在跑它** ——
 * 跟 heap 那個數字一樣，印出來、沒有擋，於是漲到 1 GB 都沒人發現。
 * 準則第八條講的就是這件事。
 *
 * ## 怎麼比
 *
 * 參考影像用一個真的 `THREE.InstancedMesh` 畫：**同一批矩陣、最細的幾何、
 * 不剔除、不選階、不合併**。那是完全獨立的路徑，不是同一份程式碼換參數。
 *
 * 判準不是逐像素相等 —— 品質契約是「幾何誤差投影到螢幕 ≤ 2 像素」，所以
 * 比的是「強化版的每個像素，在參考影像的 ±2 鄰域裡找得到相符的顏色」。
 * 逐像素相等會被輪廓平移的抗鋸齒差異淹沒，然後這個檢查就會被當成雜訊。
 *
 * ## 一個角度不夠
 *
 * 剔除的邊界情形只在**視錐邊緣正好切在某個東西的邊界上**時才分岔。單一
 * 視角量不到 —— 實測把區塊半徑縮成 0.7 倍（一個會讓整叢東西消失的錯），
 * 單一角度下鄰域外像素從 673 變成 678，也就是完全看不出來。
 *
 * 所以掃一圈相機角度，取最差的那一個。這與單元測試那邊掃 48 個角度是
 * 同一件事，只是這裡比的是真的畫出來的像素。
 *
 * ## 還沒解決：同一份程式碼、同一份內容，數字會晃 2.5 倍
 *
 * 靜態那組（`?count=20000`，完全決定性的擺放）跑兩次，鄰域外像素會落在
 * 959 與 2413 之間，梯度比 3.8 到 9.2。已經排除的：遠景合併還沒烘完
 * （縮放畫布會改變哪幾格夠遠，所以擷取前先跑 60 幀讓它穩定）。
 *
 * **在查清楚之前，這裡的門檻只能放在「整片壞掉」的等級。** 照現況調一條
 * 剛好卡住的線會得到一個看起來很嚴格、實際上什麼都擋不住的檢查 ——
 * 那比沒有檢查更糟。
 *
 * ## 兩個模式都要驗
 *
 * 靜態那條路（一次擺完）與串流那條路（區塊表、增量分組）是**兩份不同的
 * 程式碼**。這一輪抓到的四個 bug 全部只在串流那條路上出現，而靜態那條路
 * 從頭到尾都是綠的。
 */

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = join(root, 'apps/example/dist');

/**
 * 鄰域外的像素佔比上限。
 *
 * 不是 0：輪廓落在不同的像素邊界上時，抗鋸齒混出來的顏色可能在 ±2 鄰域裡
 * 根本不存在。
 *
 * **而且它每次跑都會晃 2.5 倍**（實測 0.29%–1.05%），連完全不動程式碼、
 * 完全靜態的內容也一樣。原因還沒查清楚 —— 見檔案開頭的「還沒解決」。
 *
 * 所以這條線放在 5%：那是「整片不見了」的等級，而不是一條調出來剛好卡在
 * 目前行為上的線。**一條照著現況調出來的門檻不是檢查，是快照。**
 */
const OUTSIDE_BUDGET = 0.05;

/**
 * 不合的像素要**集中在輪廓上**，不能散在整片區域裡。
 *
 * 梯度比 = 那些像素處的影像梯度 ÷ 全域平均梯度。契約允許的是輪廓位移，
 * 所以比值應該遠大於 1。接近 1 代表差異散在平坦區域 —— 那不是位移，是
 * 東西不見了或著色錯了。
 *
 * 這個數字同樣會晃（實測 3.7–9.2），理由與上面同一個。所以線放在 2：
 * 「差異完全不集中在輪廓上」才擋。
 *
 * **這一條擋得住著色與選階整片走樣，擋不住畫面最邊緣的剔除錯誤** ——
 * 邊緣只佔幾百個像素，比例上看不出來。那一類由單元測試掃 48 個角度、拿
 * 獨立實作比可見集合來擋。兩邊互補，缺一個都會漏。
 */
const GRADIENT_RATIO_MIN = 2;

async function main() {
  console.log('建置 example app…');
  execFileSync('pnpm', ['--filter', './apps/example', 'build'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  });

  const server = await serve(DIST);
  const browser = await launch();
  const failures = [];
  try {
    for (const mode of MODES) {
      const result = await run(browser, server.url, mode);
      const problem = judge(mode, result);
      if (problem !== null) failures.push(problem);
    }
  } finally {
    await browser.close();
    server.close();
  }

  if (failures.length > 0) {
    throw new Error(`畫面比對失敗：\n  ${failures.join('\n  ')}`);
  }
  console.log('\nOK: 兩個模式的畫面都在品質契約內');
}

const MODES = [
  { name: '靜態（一次擺完）', query: '?count=20000' },
  // 串流走的是另一份程式碼：區塊表、增量分組、卸載時的編號平移。
  { name: '串流（區塊表）', query: '?stream=1' },
];

async function run(browser, url, mode) {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto(url + mode.query, { waitUntil: 'load' });
  // 串流要先走一段路才有內容；遠景合併是惰性烘的，也要暖機。
  await page.waitForFunction(() => window.__ww !== undefined, undefined, { timeout: 30_000 });
  await page.waitForTimeout(3000);

  // 掃一圈相機。`verifyQuality(t)` 的 t 就是動畫時間，而相機路徑是時間的
  // 函數，所以不同的 t 就是不同的角度。串流的內容在第一次呼叫時就凍住了，
  // 所以後面幾個角度看的是同一份世界。
  let worst = null;
  for (const t of [0, 1.6, 3.2, 4.8, 6.4, 8.0, 9.6, 11.2]) {
    const one = await page.evaluate((at) => window.__ww.verifyQuality(at), t);
    if (one.skipped !== undefined) {
      await page.close();
      return { ...one, consoleErrors };
    }
    if (worst === null || (one.percent ?? Infinity) > (worst.percent ?? -Infinity)) {
      worst = { ...one, t };
    }
  }
  await page.close();
  return { ...worst, consoleErrors };
}

function judge(mode, result) {
  const line =
    `${mode.name}：${result.instances} 個 instance，` +
    `最差角度 t=${result.t}，鄰域外 ${result.outsideContract}（${result.percent}%），` +
    `梯度比 ${(result.meanGradientAtOutside / Math.max(result.meanGradientOverall, 1e-6)).toFixed(1)}`;
  console.log(`\n── ${line}`);

  if (result.skipped !== undefined) return `${mode.name}：被跳過了（${result.skipped}）`;
  // 內容根本沒進來的話，兩張圖都是空的而且完全相同 —— 那會「通過」。
  if (!(result.instances > 0)) return `${mode.name}：一個 instance 都沒有，這一組沒有驗到任何東西`;

  // **拿不到數字就是失敗，不是通過。** `percent` 少一個欄位時
  // `undefined > 0.01` 是 false —— 那個檢查會安靜地放行，而它正是這個
  // 工具存在要防的那種事。（寫這個工具的時候就犯了一次。）
  if (typeof result.percent !== 'number' || Number.isNaN(result.percent)) {
    return `${mode.name}：拿不到比對結果（percent = ${String(result.percent)}）`;
  }
  if (result.percent / 100 > OUTSIDE_BUDGET) {
    return `${mode.name}：鄰域外 ${result.percent}% 超過 ${OUTSIDE_BUDGET * 100}%`;
  }
  const ratio = result.meanGradientAtOutside / Math.max(result.meanGradientOverall, 1e-6);
  if (!Number.isFinite(ratio)) return `${mode.name}：梯度比算不出來`;
  if (result.outsideContract > 0 && ratio < GRADIENT_RATIO_MIN) {
    return `${mode.name}：不合的像素沒有集中在輪廓上（梯度比 ${ratio.toFixed(1)} < ${GRADIENT_RATIO_MIN}）`;
  }
  return null;
}

async function serve(dir) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = join(dir, path === '/' ? 'index.html' : path);
    if (!file.startsWith(dir)) {
      res.writeHead(403).end();
      return;
    }
    readFile(file).then(
      (bytes) => {
        const type =
          { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }[
            extname(file)
          ] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type });
        res.end(bytes);
      },
      () => res.writeHead(404).end(),
    );
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return { url: `http://localhost:${server.address().port}/`, close: () => server.close() };
}

async function launch() {
  const errors = [];
  for (const channel of ['chrome', undefined]) {
    try {
      // 有頭：無頭沒有真的 GPU，而這裡比的是真的畫出來的像素。
      return await chromium.launch(channel === undefined ? {} : { channel });
    } catch (error) {
      errors.push(String(error).split('\n')[0]);
    }
  }
  throw new Error(`無法啟動瀏覽器：\n  ${errors.join('\n  ')}`);
}

await main();
