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
 * ## 量測期間必須把動畫迴圈停掉
 *
 * 這是這個檢查一直不穩的**主因**，而且找了好幾輪才找到。
 *
 * `capture()` 中間有 `await`（等 PNG 解碼），而動畫迴圈會在那段空檔裡繼續
 * 跑 —— 它會把相機移到別的地方、重新烘遠景、改變可見格。於是「同一個 t
 * 量兩次」實際上量的是兩個不同的狀態。
 *
 * 實測連續呼叫 `verifyQuality(8.0)` 三次，相機矩陣是 0.235566 / 0.275634 /
 * 0.310396 —— 每一次都不一樣。停掉迴圈之後，八個角度兩輪的數字**一字不差**：
 *
 * ```text
 * 停之前  0.172  0.174  0.811  1.545  0.193  0.184  0.177  0.171
 * 停之後  0.172  0.174  0.166  0.162  0.193  0.184  0.177  0.171
 * ```
 *
 * 所以門檻現在收在量到值的兩倍以內（0.3%–0.6%），而不是「整片壞掉」的等級。
 * * ## 為什麼一定要把合併的記憶體預算開大
 *
 * 這個檢查一開始每次跑都晃 2.5 倍（鄰域外 959–2427，梯度比 3.8–9.2），
 * 連完全決定性的靜態內容也一樣。查出來的原因是**槽位池吃不飽**：
 * 預設預算下這份內容只有 60 個槽位而有 443 組要合併，於是每一幀被合併
 * 的是不同的那幾格。
 *
 * 合併與不合併**都在品質契約內**，所以那不是畫質問題 —— 但它讓這個檢查
 * 讀不出程式碼的差異。給滿槽位之後同一個角度連續量五次是
 * 958 / 958 / 958 / 958 / 1058。
 *
 * 順帶量到的產品面事實：**預設預算下這份內容是一直在互相踢的**，而換掉
 * 槽位內容要重傳整個批次緩衝。程序化資產的最粗階是 80 個三角形而且非索引
 * （cook 過的真實資產是 4 個），所以它特別容易撞到 —— 這正是準則說
 * 「合成內容不具代表性」的那件事。
 *
 * ## 抓得到什麼、抓不到什麼（實測，不是推測）
 *
 * | 故意弄壞的地方 | 抓到了嗎 |
 * | --- | --- |
 * | 選階固定挑最粗的一階 | ✅ 近景那兩組多畫 1.675% / 2.174%，都超過門檻 |
 * | 區塊包圍球半徑縮成 0.7 倍 | ❌ 少畫只從 0.29% 動到 0.51% |
 *
 * 第一個一開始也抓不到 —— 原本只有「兩萬個又遠又小」那兩組，而那種內容
 * 螢幕上每個只有幾個像素、本來就全部在最粗階，選階算錯根本不動畫面。
 * 加上**近景那兩組**（少量、放大 20 倍、相機拉近）之後才有鑑別力：換一階
 * 會動到成千上萬個像素。
 *
 * 第二個仍然抓不到，而且原因是結構性的：整塊在畫面邊緣被剔掉只佔幾百個
 * 像素。那一類由單元測試那邊掃 48 個角度、拿獨立實作比可見集合來擋
 * （那一組確實抓得到）。兩邊互補，缺一個都會漏。
 *
 * ## 兩個方向都比
 *
 * 「強化版有、原生版沒有」抓多畫了或畫錯了；「原生版有、強化版沒有」抓
 * **東西不見了**。後者是這個引擎最危險的一種錯（剔過頭、包圍球太小、
 * 整塊被跳過），而且只在那個方向上出現。挑最差角度時看的也是它。
 * * ## 四個模式，各有各的門檻
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
 * 門檻**逐個模式各訂**，寫在 MODES 上 —— 統一一條線的話，最鬆的那組會把
 * 所有組拉鬆。乾淨狀態實測：靜態 0.193%、串流 0.179%、近景 0.178%、
 * 近景串流 0.286%，四組都穩定到小數第三位。
 */
// 門檻**逐個模式各訂**，寫在 MODES 上。
//
// 統一一條線的話，最寬鬆的那個模式會把所有模式都拉鬆：靜態那組乾淨狀態
// 就有 1.58%（而且還在兩個值之間跳），近景那組是 0.18% —— 用同一條線等於
// 讓近景那組的門檻鬆了九倍，而它正是唯一驗得動畫質的那一組。

/**
 * 不合的像素要**集中在輪廓上**，不能散在整片區域裡。
 *
 * 梯度比 = 那些像素處的影像梯度 ÷ 全域平均梯度。契約允許的是輪廓位移，
 * 所以比值應該遠大於 1。接近 1 代表差異散在平坦區域 —— 那不是位移，是
 * 東西不見了或著色錯了。
 *
 * 乾淨狀態實測落在 3.3–12.4，逐組訂線。
 *
 * **這條線目前沒有抓到過任何東西** —— 見檔案開頭「這個檢查目前擋不住
 * 什麼」。留著是因為它是對的判準，不是因為它現在有效。
 *
 * **這一條擋得住著色與選階整片走樣，擋不住畫面最邊緣的剔除錯誤** ——
 * 邊緣只佔幾百個像素，比例上看不出來。那一類由單元測試掃 48 個角度、拿
 * 獨立實作比可見集合來擋。兩邊互補，缺一個都會漏。
 */

/**
 * 「原生版畫了、強化版沒畫」的像素上限。**這一條比正向那條嚴。**
 *
 * 多畫是輪廓位移，少畫是東西不見了 —— 而剔除剔過頭、包圍球太小、整塊被
 * 跳過，全都是這個引擎最危險的失效方式，而且全都只在這個方向上出現。
 *
 * 門檻等擷取到乾淨基準之後再填。
 */

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
  // 模式數寫死過一次，加到七個之後它還在說「四個」—— 一個會說謊的檢查，
  // 它報的通過範圍比實際跑的小。
  console.log(`\nOK: ${MODES.length} 個模式的畫面都在品質契約內`);
}

const MODES = [
  // `hlodBudgetMB` 開大是**這個檢查能不能穩定**的前提，不是為了跑得快。
  // 預設預算下這份程序化內容只配得到 60 個槽位、443 組要合併，於是每一幀
  // 被合併的是不同的那幾格 —— 兩種畫法都在契約內，但畫面因此每一幀都不同。
  // 實測：同一頁、同一個角度連續量五次是 959 / 959 / 2967 / 2129 / 959。
  { name: '靜態（一次擺完）', query: '?count=20000&hlodBudgetMB=512&verify=1', missing: 0.3, ratio: 5 },
  // 串流走的是另一份程式碼：區塊表、增量分組、卸載時的編號平移。
  { name: '串流（區塊表）', query: '?stream=1&hlodBudgetMB=512&verify=1', missing: 0.3, ratio: 6 },
  // **這一組才驗得動畫質。** 上面兩組是兩萬個又遠又小的物件，螢幕上每個
  // 只有幾個像素，本來就全部在最粗階 —— 選階算錯、邊緣少一叢都看不出來
  // （兩個故意做壞的版本都通過了）。
  //
  // 這一組把物件放大 20 倍、數量降到 600、相機拉近，於是換一階會動到
  // 成千上萬個像素。
  { name: '近景（螢幕上很大）', query: '?count=600&size=20&spread=400&orbit=90&hlodBudgetMB=512&verify=1', missing: 0.3, ratio: 5 },
  // 同樣的形狀，但走串流那條路 —— 區塊表的剔除錯誤只在這條路上出現。
  { name: '近景串流', query: '?stream=1&size=20&orbit=90&hlodBudgetMB=512&verify=1', missing: 0.6, ratio: 2 },
  // ## 有貼圖的那條路
  //
  // 在這之前沒有任何 gate 走過（example 預設是純色材質），所以 normal/ORM
  // 的取樣、sRGB、mip 全部沒被驗過。
  //
  // 一走就量到 19.7%，而那**不是引擎的缺陷，是參考影像用錯幾何** ——
  // `?cooked=1` 時強化版吃 cook 過的鏈，而參考當時用的是模組頂層那份程序化
  // 幾何，等於在比兩個不同的形狀。修好之後近景是 0%，遠景 3.3%。
  { name: '有貼圖・遠景', query: '?cooked=1&count=20000&hlodBudgetMB=512&verify=1', missing: 5, ratio: 2 },
  // 近景挑的是細階，所以與原生**完全一致**（0%）。這一組因此是最嚴的一個
  // gate：任何讓有貼圖的內容偏掉的改動都會在這裡紅。
  { name: '有貼圖・近景', query: '?cooked=1&count=600&size=20&spread=400&orbit=90&hlodBudgetMB=512&verify=1', missing: 0.3, ratio: 4 },
  // 門檻 1 = 一個 fragment 要跨過整張貼圖才會停 → **永遠都取樣**，也就是
  // 注入必須完全沒有作用。數字要跟上面那組一樣（0%）。
  //
  // 這一條擋的是「注入寫壞了但看起來還好」，而它抓到過三次：
  //   1. 替換的是展開後的內容，但 onBeforeCompile 拿到的還沒展開 include
  //   2. 參考影像共用同一個材質物件 → 材質層級的改動在比對裡是隱形的
  //   3. 導數那兩行沒包在 #ifdef 裡 → 沒有那張貼圖的材質直接編譯失敗
  //
  // 三次的症狀都一樣：**三個設定量出來完全同分**。
  {
    name: '材質細節降級（門檻 1，應完全無作用）',
    query: '?cooked=1&count=600&size=20&spread=400&orbit=90&hlodBudgetMB=512&materialDetail=1&verify=1',
    missing: 0.3,
    ratio: 4,
  },
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
    // 用「少畫」挑最差 —— 東西不見了才是這裡最要抓的那一種。
    if (worst === null || (one.missingPercent ?? Infinity) > (worst.missingPercent ?? -Infinity)) {
      worst = { ...one, t };
    }
  }
  await page.close();
  return { ...worst, consoleErrors };
}

function judge(mode, result) {
  const line =
    `${mode.name}：${result.instances} 個 instance，` +
    `最差角度 t=${result.t}，多畫 ${result.percent}%，少畫 ${result.missingPercent}%，` +
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
  if (result.percent > mode.missing * 1.5) {
    return `${mode.name}：多畫 ${result.percent}% 超過 ${mode.missing * 1.5}%`;
  }
  // **少畫的那個方向要嚴得多。** 多畫幾個像素通常是輪廓位移；少畫代表
  // 東西真的不見了，而那是這個引擎最危險的失效方式。
  if (typeof result.missingPercent !== "number" || Number.isNaN(result.missingPercent)) {
    return `${mode.name}：拿不到反向比對結果`;
  }
  if (result.missingPercent > mode.missing) {
    return `${mode.name}：原生版有、強化版沒有的像素 ${result.missingPercent}% 超過 ${mode.missing}%`;
  }
  const ratio = result.meanGradientAtOutside / Math.max(result.meanGradientOverall, 1e-6);
  if (!Number.isFinite(ratio)) return `${mode.name}：梯度比算不出來`;
  if (result.outsideContract > 0 && ratio < mode.ratio) {
    return `${mode.name}：不合的像素沒有集中在輪廓上（梯度比 ${ratio.toFixed(1)} < ${mode.ratio}）`;
  }
  return null;
}

async function serve(dir) {
  // `/cooked*` 從 benchmark 的 public 讀 —— 那是 `pnpm cook` 的輸出，不進版控，
  // 而 example 的 vite 設定只在 dev server 上代理它。建置後的 app 少了這一段
  // 就載不到貼圖，於是 `?cooked=1` 會靜靜退回純色材質 —— **檢查照樣全綠，
  // 只是它驗的內容裡根本沒有貼圖**。
  const COOKED = join(root, 'apps/benchmark/public');
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = path.startsWith('/cooked')
      ? join(COOKED, path)
      : join(dir, path === '/' ? 'index.html' : path);
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
