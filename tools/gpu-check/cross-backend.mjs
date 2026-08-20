/**
 * 同一個效果，兩個後端，必須算出同一組數字。
 *
 * ## 為什麼需要這一道
 *
 * `WebGPURenderer` 不吃 `ShaderMaterial`、也不經過 `onBeforeCompile`，所以
 * 每個注入著色器的效果都要有**第二份實作**（node / TSL）。
 *
 * 兩份實作的失效方式是這個專案最怕的那一種：不報錯、幀時間正常，只是其中
 * 一邊的畫面不一樣。而「記得一起改」這種註解擋不住它 —— 套件裡的間接光與
 * VAT 已經各有兩份，而它們原本只驗「WebGPU 那邊有在動」，沒有驗「兩邊一樣」。
 *
 * 這一道就是那個缺口：同一個場景、同一組參數，兩個後端各跑一次，比數字。
 *
 * ## 每個效果只要往 `EFFECTS` 加一列
 *
 * 量測函式**兩邊共用同一支**。各寫一份的話量到的差異裡混著「量法不同」，
 * 而那分不開。
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

console.log('跨後端：同一個效果，兩邊要算出同一組數字');
let failed = 0;
const check = (ok, message) => {
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + message);
  if (!ok) failed++;
};

/**
 * 每個效果一列。
 *
 * - `key`：`window.__ww` / `window.__wwgpu` 底下的名字。
 * - `measure`：在頁面裡跑，回傳一個**數字陣列**。兩邊共用同一支。
 * - `pair`：WebGL 的第 i 個量對應 WebGPU 的第幾個。cube 那種面被對調的才要。
 * - `floor`：小於這個絕對值的差就當成 0。**可以給一個陣列**，每個量各自一個。
 *
 *   同一個陣列裡混著不同尺度的量時，單一個 floor 會把小尺度那些整個吃掉。
 *   實測踩過：接觸陰影的取樣值是 0..1 的 8 位元量（floor 用 1/255 合理），
 *   而「整張暗的比例」有意義的差異只有千分之幾 —— 於是 0.00524 對 0.00596
 *   （差 13.7%）被報成 0.000%，而那個差正是一個 4 倍的實作改動造成的。
 */
const EFFECTS = [
  {
    name: '天空（大氣散射）',
    key: 'sky',
    glUrl: '/?sky=1&verify=1',
    gpuUrl: '/webgpu.html?sky=1',
    labels: ['+X R', '+X G', '+X B', '−X R', '−X G', '−X B', '+Y R', '+Y G', '+Y B', '−Y R', '−Y G', '−Y B', '+Z R', '+Z G', '+Z B', '−Z R', '−Z G', '−Z B'],
    /**
     * cube 的 X 面在兩個後端是對調的。
     *
     * 那不是 bug，是 Three 的約定差異 —— 套件的 `projectCubeToSH` 早就有一個
     * `flip` 參數（WebGL −1、WebGPU +1）在處理它。所以 0–2 對到 3–5、
     * 3–5 對到 0–2，其餘照舊。
     */
    pair: [3, 4, 5, 0, 1, 2, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
    /** 朝下那一面是 2e-5 等級，相對差在那裡沒有意義。 */
    floor: 1e-5,
    measure: async (api) => {
      // 太陽固定在同一個高度角 —— 兩邊比的必須是同一個天空。
      api.setSun(0.6);
      const out = [];
      for (let f = 0; f < 6; f++) out.push(...(await api.sampleFaceAsync(f)));
      return out;
    },
  },
  {
    name: '接觸陰影',
    key: 'contact',
    glUrl: '/?contact=1&verify=1',
    gpuUrl: '/webgpu.html?contact=1',
    labels: ['接縫處', '空地', '受光面', '明暗交界', '物體下方', '整張暗的比例'],
    // 前五個是 0..1 的 8 位元取樣，最後一個是「整張暗的比例」——
    // 那個量的有意義差異小兩個數量級，不能共用同一個 floor。
    floor: [1 / 255, 1 / 255, 1 / 255, 1 / 255, 1 / 255, 1e-4],
    /**
     * 讀一小塊的平均，不是單一個像素。
     *
     * 接觸陰影的斑塊只佔畫面 0.5%，而取樣點就在它的邊緣上 —— 差一個像素
     * 就是 0.10 與 1.00 的差別。那量的是「邊緣剛好落在哪」，不是「效果對不對」。
     * 天空那邊改成整面平均是同一個理由。
     */
    measure: async (api) => {
      api.render();
      const out = [];
      for (const which of ['contact', 'open', 'lit', 'terminator', 'under']) {
        out.push(await api.sampleWindowAsync(which, 9));
      }
      // 整張遮罩有多少比例是暗的 —— 一個與取樣位置完全無關的量。
      out.push(await api.coverageAsync());
      return out;
    },
  },
  {
    name: '虛擬陰影圖',
    key: 'vsm',
    glUrl: '/?vsm=8&verify=1',
    gpuUrl: '/webgpu.html?vsm=8',
    labels: [
      '遮罩 v20 u20', '遮罩 v20 u35', '遮罩 v20 u50', '遮罩 v20 u65', '遮罩 v20 u80',
      '遮罩 v35 u20', '遮罩 v35 u35', '遮罩 v35 u50', '遮罩 v35 u65', '遮罩 v35 u80',
      '遮罩 v50 u20', '遮罩 v50 u35', '遮罩 v50 u50', '遮罩 v50 u65', '遮罩 v50 u80',
      '遮罩 v65 u20', '遮罩 v65 u35', '遮罩 v65 u50', '遮罩 v65 u65', '遮罩 v65 u80',
      '遮罩 v80 u20', '遮罩 v80 u35', '遮罩 v80 u50', '遮罩 v80 u65', '遮罩 v80 u80',
      '亮處 光源 U', '亮處 光源 V', '亮處 光源深度',
      '影中 光源 U', '影中 光源 V', '影中 光源深度',
      '亮處 頁 X', '亮處 頁 Y', '亮處 階',
      '影中 頁 X', '影中 頁 Y', '影中 階',
      '亮處 圖集 U', '亮處 圖集 V', '影中 圖集 U', '影中 圖集 V',
      '亮處 存的深度', '影中 存的深度',
      '亮處 深度差', '影中 深度差',
      '亮處 位元 R', '亮處 位元 G', '亮處 位元 B',
      '影中 位元 R', '影中 位元 G', '影中 位元 B',
      '圖集 s0 R', '圖集 s0 G', '圖集 s0 B',
      '圖集 s1 R', '圖集 s1 G', '圖集 s1 B',
      '圖集 s2 R', '圖集 s2 G', '圖集 s2 B',
      '圖集 空 R', '圖集 空 G', '圖集 空 B',
    ],
    /**
     * 遮罩是**逐像素的 0 或 1**，所以它是位置的階梯函數 —— 半個像素的柵格化
     * 差異直接搬動邊緣（見水那一項的說明）。地板 0.02 是那個搬動在 64×48
     * 的窗口裡能造成的量級：實測影子裡有 0.005–0.011 的零星亮點只出現在一邊。
     */
    floor: { 遮罩: 0.02, default: 1 / 255 },
    /**
     * ## 這一項比前面幾個多驗一段：**頁表與圖集**
     *
     * 前面那些效果的中間值都在同一支著色器裡算完。虛擬陰影圖不是 —— 它先把
     * 場景畫進一張圖集，再用頁表把螢幕上的一點對到圖集裡的一格。那條路上有
     * 好幾個地方會靜靜地錯，而**每一個的症狀都是「影子怪怪的」**：
     *
     * | 除錯號碼 | 量的是什麼 | 錯了會怎樣 |
     * | ---: | --- | --- |
     * | 1 | 光源空間的 uv 與深度 | 整片陰影位移或旋轉 |
     * | 2 | 頁表查到的槽位與階 | 取到別頁的深度，影子破碎 |
     * | −2 | 圖集座標 | 同上，但錯在最後一步 |
     * | −1 | 圖集裡存的深度 | 圖集根本沒畫對 |
     * | 3 | 存的深度減目前深度 | 偏移的尺度 |
     * | 4 | 圖集裡沒解碼的位元組 | 編碼不同 vs 畫錯位置 |
     *
     * ## 而最後還要**直接讀圖集**
     *
     * 上面每一項走的都是「從螢幕查過去」，那條路上疊著頁表與取樣的翻轉約定，
     * 而它們會互相抵銷成「就是黑的」。實測：WebGPU 的頁畫到了上下鏡像的槽位，
     * 而從螢幕查過去的每一個中間值（光源 uv、槽位、階、圖集座標）都與 WebGL
     * **完全相同**，只有取到的深度是 0。
     *
     * 直接讀圖集（`readPixelsAsync` 已經把兩邊的列順序對齊過）一眼就看出來：
     * 內容一個在 v≈0.02、一個在 v≈0.98。
     */
    tolerance: 0.02,
    measure: async (api) => {
      api.settle();
      const out = [];

      // ## 整片遮罩，不是幾個點
      //
      // 手挑的取樣點會挑錯。第一版三個點裡有兩個其實都在影子裡，而「照得到的
      // 地方是亮的」那條斷言因此在**兩邊都紅**——看起來像效果壞了。
      const ROWS = [0.2, 0.35, 0.5, 0.65, 0.8];
      api.resolve(0);
      for (const v of ROWS) {
        for (const u of ROWS) out.push((await api.sampleWindowAsync(u, v, 64, 48))[0]);
      }

      // 兩個**量出來**的位置：實亮與實暗，都不在邊界上。
      const LIT = [0.8, 0.65];
      const DARK = [0.35, 0.35];
      const pair = [LIT, DARK];
      const spot = (u, v) => api.sampleWindowAsync(u, v, 48, 24);

      for (const [mode, take] of [
        [1, (c) => c],
        [2, (c) => c],
        [-2, (c) => [c[0], c[1]]],
        [-1, (c) => [c[0]]],
        [3, (c) => [c[0]]],
        [4, (c) => c],
      ]) {
        api.resolve(mode);
        for (const [u, v] of pair) out.push(...take(await spot(u, v)));
      }

      // 直接讀圖集：前三格有內容，第四個位置是空的（沒有頁落在那裡）。
      for (const [u, v] of [
        [0.02, 0.02],
        [0.06, 0.02],
        [0.1, 0.02],
        [0.5, 0.5],
      ]) {
        out.push(...(await api.atlasWindowAsync(u, v, 16)));
      }
      return out;
    },
    /**
     * 兩份一起錯的話「兩邊一致」照樣是綠的 —— 所以要有一條不看對方的。
     *
     * 判準是**這張遮罩上真的有影子也有光**，而且圖集裡真的有東西。全亮、全暗、
     * 或圖集全空都代表整條路斷了，而那正是兩邊最可能一起錯的情況。
     */
    absolute: (get) => [
      [get('遮罩 v65 u80') > 0.9, `照得到的地方是亮的 —— ${get('遮罩 v65 u80').toFixed(3)}`],
      [get('遮罩 v35 u35') < 0.1, `影子裡是暗的 —— ${get('遮罩 v35 u35').toFixed(3)}`],
      [
        get('遮罩 v80 u65') > 0.2 && get('遮罩 v80 u65') < 0.9,
        `影子有邊界，不是整片同一個值 —— ${get('遮罩 v80 u65').toFixed(3)}`,
      ],
      [
        get('圖集 s0 R') > 0.01 && get('圖集 s0 R') < 0.99,
        `圖集裡真的有畫東西 —— 第一格的 R ${get('圖集 s0 R').toFixed(4)}`,
      ],
      [
        get('圖集 空 R') === 0,
        `沒有頁落到的地方是空的 —— ${get('圖集 空 R').toFixed(4)}`,
      ],
    ],
  },
  {
    name: '水的外觀',
    key: 'waterLook',
    glUrl: '/?waterlook=1&verify=1',
    gpuUrl: '/webgpu.html?waterlook=1',
    labels: [
      '淺 travelled', '中 travelled', '掠 travelled',
      '淺 水面深度', '中 水面深度', '掠 水面深度',
      '淺 水底深度', '中 水底深度', '掠 水底深度',
      '淺 R', '淺 G', '淺 B', '中 R', '中 G', '中 B', '掠 R', '掠 G', '掠 B',
      '淺 折射 R', '淺 折射 G', '淺 折射 B',
      '中 折射 R', '中 折射 G', '中 折射 B',
      '掠 折射 R', '掠 折射 G', '掠 折射 B',
      '淺 位移 U', '淺 位移 V', '中 位移 U', '中 位移 V', '掠 位移 U', '掠 位移 V',
      '淺 法線 X', '淺 法線 Y', '淺 法線 Z',
      '中 法線 X', '中 法線 Y', '中 法線 Z',
      '掠 法線 X', '掠 法線 Y', '掠 法線 Z',
      '淺 對 CPU', '中 對 CPU', '掠 對 CPU',
      '泡沫 v.13', '泡沫 v.17', '泡沫 v.21', '泡沫 v.25',
      '淺 折射反應', '中 折射反應', '掠 折射反應',
    ],
    /**
     * 「對 CPU」的地板就是那條主張自己的門檻（0.05 公尺）：小於它的殘差兩邊
     * 算不算得上一致沒有意義，真正在管的是下面那條單邊主張。泡沫同理。
     * 折射反應的地板 0.01 是「動了沒」的分界：低於它就是沒動，而兩個沒動
     * 的數字誰比誰大沒有意義（掠射角那一列幾乎全是反射，就是這種）。
     */
    floor: { 對: 0.05, 泡沫: 1, 反應: 0.01, default: 1e-4 },
    /**
     * ## 門檻是量出來的，而量之前得先知道自己在量什麼
     *
     * 一開始整個效果共用 12%，理由是「`travelled` 是兩個大數相減，病態」。
     * 那個說法讓「吸收係數改 15%」整個漏過去 —— 12% 的門檻等於沒有門檻。
     *
     * 追下去發現病態不是原因。把中間值一層一層印出來比對（debug 1/5/10 就是
     * 為此存在的），整條鏈對得起來：位移的比 0.00181/0.00201 = 0.900，法線 x
     * 的比 0.10328/0.11434 = 0.903 —— 下游全部來自同一個源頭。
     *
     * ## 源頭是兩邊把同一片水柵格化到差約 0.4 個像素的地方
     *
     * 量法：debug 1 的 worldZ 沿 v 逐列掃描，每列梯度 0.176 公尺，兩邊差
     * 0.049–0.083 公尺 —— 換算 0.28–0.47 列。次像素，不是差一整列。
     *
     * **沒有一邊是錯的**：兩邊的水面都對得上 CPU 的 `heightAt`（差 0.02–0.04
     * 公尺，限 0.05）。天空那一項是全螢幕 pass，兩邊逐位元相同，所以讀回與
     * 取樣窗口也沒有偏移。深度貼圖的位元數也不是（見 `water-surface.ts`）。
     *
     * ## 所以量法要對那半個像素免疫
     *
     * 平滑的量對半像素平移只反應 0.1%；隨浪震盪的量才會炸開。橫向平均掃過
     * 很多個浪頭就會塌下去 —— 實測法線的差隨窗口 9×9 → 33×33 → 64×64 是
     * 1.43% → 0.94% → 0.36%，單調。
     *
     * 所以取**又寬又扁的一條**（256×16）：橫向平掉震盪，上下只取 16 列以
     * 保住由近到遠的深淺分層。改用 64×64 的方塊不行，近處那一塊會吃到岸邊。
     *
     * ## 取樣的列也要避開岸線
     *
     * 岸邊的每個量都是位置的**階梯函數**，而平均救不了階梯 —— 半個像素的
     * 位移直接搬動階梯的邊緣。實測 v=0.19 那一列泡沫差 25%、綠色差 19%，
     * 而同樣的東西在 v=0.24 只差 1% 上下。
     *
     * 所以三列全部放在岸線外（v = 0.24 / 0.32 / 0.44），而「岸邊有泡沫」改成
     * 一條**形狀**的單邊主張 —— 那本來就是它要講的事，不是某一點的值。
     *
     * ## 這道關卡看得見多小的漂移
     *
     * 紅測（把 node 那份的吸收係數乘上一個倍率，只動一邊）：
     *
     * | 改動 | 結果 |
     * | --- | --- |
     * | +15% | 紅，六個量同時紅（最大 12.1%）|
     * | +5%  | 紅（中 G 3.57% 對門檻 3%）|
     * | +3%  | **過**（中 折射 B 3.78% 對門檻 4%）|
     *
     * 下限在 3% 與 5% 之間。折射的門檻壓到 3% 就抓得到 3%，但那只剩 1.5 倍
     * 餘裕 —— 而會隨機變紅的關卡不是關卡。
     *
     * 對照：改成每個量各自一個門檻之前，整個效果共用 12%，連 +15% 都漏。
     *
     * 下面每個數字都是**量到的差**的兩倍上下 —— 留給別台機器的驅動差異，
     * 不留給實作不同。註解裡是這台機器上量到的。
     */
    tolerance: {
      // 鍵是**依序**比對的，所以更精確的要放前面 —— 「淺 折射反應」也
      // 含有「折射」。
      反應: 1, // 問的是「動了沒」，不是「兩邊動一樣多」
      travelled: 0.05, // 3.18%
      水面深度: 0.002, // 0.086%
      水底深度: 0.04, // 1.54% —— 掠射角讀到的是天空罩，而那是 16×12 段的多面體
      折射: 0.04, // 1.97%
      位移: 0.02, // 低於地板
      法線: 0.003, // 0.119%
      對: 0.5, // 逐點的殘差，真正在管的是下面那條單邊主張
      泡沫: 1, // 同上
      default: 0.03, // 最後的顏色，1.46%
    },
    /**
     * ## 單邊的主張
     *
     * 「兩邊一致」只證明兩份實作互相一樣。兩份一起錯的話這個關卡整片綠 ——
     * 而 `irradiance-node.ts` 與 VAT 兩份實作就這樣裸奔了很久。
     *
     * 一、**畫出來的水面就是浮力用的那一個**。這是 `water.ts` 存在的理由：
     * 兩邊各寫一份的話東西會浮在錯的高度，而那不會報錯，只是「看起來怪怪
     * 的」。必須**逐點**量：sin 的平均不等於平均的 sin，所以在平均過的座標
     * 上問 `heightAt` 問到的是別的東西（實測 256×16 的窗口讓殘差變成
     * 0.18–0.58 公尺，兩邊一起）。
     *
     * 二、**岸邊有泡沫、深水沒有**。判準是形狀不是值：由岸往外單調遞減，
     * 岸邊夠白、深水歸零。
     */
    absolute: (get) => {
      const rows = ['淺', '中', '掠'].map((where) => [
        Math.abs(get(`${where} 對 CPU`)) < 0.05,
        `${where}處畫出來的水面就是浮力用的 —— 差 ${get(`${where} 對 CPU`).toFixed(4)} 公尺`,
      ]);
      const foam = ['v.13', 'v.17', 'v.21', 'v.25'].map((v) => get(`泡沫 ${v}`));
      return [
        ...rows,
        [foam[0] > 0.3, `岸邊夠白 —— ${foam[0].toFixed(3)}`],
        [
          foam.every((value, i) => i === 0 || value < foam[i - 1]),
          `泡沫由岸往外單調遞減 —— ${foam.map((f) => f.toFixed(3)).join(' → ')}`,
        ],
        [foam[3] < 0.01, `深水沒有泡沫 —— ${foam[3].toFixed(4)}`],
        // 三、**改參數這一邊收得到**。`setRefraction` 曾經只改 WebGL 那份
        // 材質的 uniform，WebGPU 上一個字都收不到 —— 而兩邊都停在預設值
        // 的話，上面每一條照樣是綠的。掠射角那一列幾乎全是反射，折射的
        // 權重太低，所以只問淺與中。
        ...['淺', '中'].map((where) => [
          get(`${where} 折射反應`) > 0.02,
          `${where}處折射的參數收得到 —— 推大六倍讓顏色動了 ${(
            get(`${where} 折射反應`) * 100
          ).toFixed(2)}%`,
        ]),
      ];
    },
    measure: async (api) => {
      await api.settle();
      const out = [];
      // 淺水、中段、掠射角（反射為主）—— 三列都在岸線外。
      const ROWS = [0.24, 0.32, 0.44];
      const strip = (v) => api.sampleWindowAsync(0.3, v, 256, 16);
      const push = async (mode, take) => {
        api.render(mode);
        for (const v of ROWS) out.push(...take(await strip(v)));
      };

      await push(2, (c) => [c[0]]); // travelled
      await push(8, (c) => [c[0]]); // 水面深度
      await push(9, (c) => [c[0]]); // 水底深度
      await push(0, (c) => c); // 最後的顏色
      // ## 折射後的顏色 —— 一個直接受吸收影響、又不是兩個大數相減的量
      await push(6, (c) => c);
      // 位移與法線不是主張，是**下次對不上時的第一站**：位移不對就往法線看，
      // 法線也不對就往波形看。沒有它們的話那一輪要從頭再挖一次。
      await push(10, (c) => [c[0], c[1]]);
      await push(5, (c) => c);

      // 逐點：跟 CPU 對答案。平均過的座標問不出這件事。
      api.render(1);
      for (const v of ROWS) {
        const [x, y, z] = await api.sampleWindowAsync(0.3, v, 1);
        out.push(y - api.heightAt(x, z));
      }
      // 泡沫由岸往外 —— 量的是形狀，所以要跨過岸線。
      api.render(3);
      for (const v of [0.13, 0.17, 0.21, 0.25]) out.push((await strip(v))[0]);

      // ## 改一個參數，兩邊都要跟著動
      //
      // 上面每一項量的都是**同一組設定**下的結果。那抓不到「這個參數在
      // 其中一邊根本沒接上」—— 兩邊都停在預設值的話照樣一致。
      //
      // 實測踩過：範例場景的 `setRefraction` 直接改 `material.uniforms`，
      // 而那是 WebGL 那份材質。WebGPU 上一個字都收不到，而症狀是「折射
      // 在 WebGPU 上沒反應」，看起來像效果本身壞了。
      //
      // 比的是**這一邊自己**動了多少，不是兩邊動完之後還要一致：折射推大
      // 六倍會把取樣點推到離水面更遠的地方，於是兩邊那半個像素的差被放大
      // （實測跨後端差 11.6%）。那量的是放大率，不是「參數接上了沒」。
      const before = [];
      api.render(6);
      for (const v of ROWS) before.push(await strip(v));
      api.setRefraction(0.3);
      api.render(6);
      for (let i = 0; i < ROWS.length; i++) {
        const after = await strip(ROWS[i]);
        out.push(
          Math.max(...after.map((x, c) => Math.abs(x - before[i][c]) / Math.max(before[i][c], 1e-6))),
        );
      }
      api.setRefraction(0.05);
      return out;
    },
  },
  {
    name: '追蹤反射（含反射探針）',
    key: 'reflProbe',
    glUrl: '/?reflprobe=1&verify=1',
    gpuUrl: '/webgpu.html?reflprobe=1',
    labels: ['偏 +x R', '偏 +x G', '偏 +x B', '偏 −x R', '偏 −x G', '偏 −x B', '偏 −z R', '偏 −z G', '偏 −z B'],
    floor: 1e-4,
    measure: async (api) => {
      await api.settle();
      api.render(true);
      const out = [];
      // 三個方向：+x 紅牆、−x 藍牆、−z 黃牆。最後一個的反射方向 z 為負，
      // 走的是八面體的折疊分支 —— 那一段只有它驗得到。
      for (const [x, z] of [[30, 0], [-30, 0], [0, -25]]) {
        out.push(...(await api.sampleWindowAsync(x, z, 9)));
      }
      return out;
    },
  },
  {
    name: '體積霧',
    key: 'fog',
    glUrl: '/?fog=1&verify=1',
    gpuUrl: '/webgpu.html?fog=1',
    labels: ['穿過缺口 R', '穿過缺口 A', '被牆擋住 R', '被牆擋住 A', '天空 R', '天空 A'],
    floor: 1e-4,
    measure: async (api) => {
      // 距離場是分幀建的 —— 不 settle 的話遮蔽全部不生效，而那不會報錯。
      api.settle();
      api.render(true);
      const spots = api.spots();
      const out = [];
      for (const which of ['throughGap', 'behindWall', 'sky']) {
        // 讀一小塊的平均：霧有抖動，單點量到的是抖動的相位。
        const c = await api.sampleWindowAsync(spots[which][0], spots[which][1], 8);
        out.push(c[0], c[3]);
      }
      return out;
    },
  },
  {
    name: '距離場陰影',
    key: 'dfShadow',
    glUrl: '/?dfshadow=1&verify=1',
    gpuUrl: '/webgpu.html?dfshadow=1',
    labels: ['影子裡', '空地', '箱子後面', '場外面', '箱頂', '明暗交界', '整張暗的比例'],
    // 前六個是 0..1 的 8 位元取樣，最後一個是比例 —— 尺度差兩個數量級。
    floor: [1 / 255, 1 / 255, 1 / 255, 1 / 255, 1 / 255, 1 / 255, 1e-4],
    measure: async (api) => {
      // ## 兩邊都要 settle
      //
      // 距離場是分幀建起來的。不 settle 就量的話場是空的 —— 而空的場**不會
      // 報錯**，只是完全沒有陰影。實測 WebGL 那側整片 1.0、WebGPU 那側因為
      // 初始化時剛好叫過而有陰影，於是兩邊差 100%，看起來像 TSL 那份寫錯。
      api.settle();
      api.render();
      const out = [];
      for (const which of ['shadow', 'open', 'behind', 'outside', 'boxTop', 'terminator']) {
        out.push(await api.sampleWindowAsync(which, 9));
      }
      out.push(await api.coverageAsync());
      return out;
    },
  },
  {
    name: '間接光探針的 SH 係數',
    key: 'gi',
    glUrl: '/?gi=1&verify=1',
    gpuUrl: '/webgpu.html?gi=1',
    labels: ['朝 −x−z', '朝 +x+z', '朝上', '朝下'],
    floor: 0.005,
    /**
     * ## 這一項的容差比別的鬆，而那是有理由的
     *
     * 別的效果比的是**同一份輸入**上的計算，所以可以要求 0.5%。這一項比的是
     * 兩邊各自**把場景拍成 cubemap** 再投影 —— 光柵化規則與材質實作本來就有
     * 差異，逐位元相同做不到。實測是 0.6–5.5%。
     *
     * 但它仍然抓得到真正的錯：cube target 的型別設錯時，方向性整個被抹平
     * （兩個相反的法線 0.626 對 0.636），那是 120% 的差。
     */
    tolerance: 0.1,
    measure: async (api) => {
      let rounds = 0;
      while (api.stats().baked < api.stats().probes && rounds < 2000) {
        await api.bake();
        rounds++;
      }
      const points = [
        [[-5, 14, -5], [-0.707, 0, -0.707]],
        [[-5, 14, -5], [0.707, 0, 0.707]],
        [[-5, 14, -5], [0, 1, 0]],
        [[-5, 14, -5], [0, -1, 0]],
      ];
      // 只看紅通道 —— 那個場景裡紅牆是唯一的間接光來源，訊號全在那裡。
      return points.map(([p, n]) => api.sampleCpu(p, n)[0]);
    },
  },
];

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const base = `http://localhost:${server.address().port}`;

/**
 * 兩個數字差多少 —— 相對差，但很小的值改看絕對差。
 *
 * ## 為什麼要兩個判準
 *
 * 幾乎全黑的通道（例如天空朝下那一面，2e-5 等級）的**相對**差沒有意義：
 * 分母太小，半精度的最後一個位元就是好幾個百分點。
 *
 * 全部用相對的話門檻就被那種值綁架：實測有意義的那幾個是 0.00%，而那一面是
 * 0.03%，於是門檻只能放到 2% —— 而 2% 藏得住「TSL 那份的光線步數從 8 改成
 * 6」（實測 1.63%）。**訂得下的門檻，就藏得住東西。**
 */
/**
 * ## 門檻與地板都可以每個量各自一個
 *
 * 三種寫法：
 *   - 數字 —— 整個效果共用
 *   - 陣列 —— 跟 `labels` 同序
 *   - 物件 —— 鍵是 label 的子字串，`default` 收沒對到的
 *
 * 物件那種是給量多的效果用的。水面有 30 個量，一個 30 格的陣列跟 labels
 * 對錯一格不會有任何人看出來 —— 那種錯誤只會表現成「某個量的門檻莫名其妙
 * 地鬆」，也就是這個關卡最不該有的東西。
 *
 * 所以打錯的鍵要當場炸掉：沒對到任何 label 的鍵一律視為錯字，因為它的症狀
 * 是「那些量全部掉到 default」，而 default 通常比較鬆。
 */
const perQuantity = (spec, index, label, fallback) => {
  if (spec === undefined) return fallback;
  if (typeof spec === 'number') return spec;
  if (Array.isArray(spec)) return spec[index];
  for (const [key, value] of Object.entries(spec)) {
    if (key !== 'default' && label.includes(key)) return value;
  }
  return spec.default ?? fallback;
};

/** 物件寫法的鍵有沒有打錯 —— 打錯的鍵不會對到任何 label。 */
const unmatchedKeys = (spec, labels) => {
  if (spec === undefined || typeof spec === 'number' || Array.isArray(spec)) return [];
  return Object.keys(spec).filter(
    (key) => key !== 'default' && !(labels ?? []).some((label) => label.includes(key)),
  );
};

const difference = (a, b, floor) => {
  // ## NaN 要當成**最壞**，不是當成 0
  //
  // `Math.abs(a - NaN)` 是 NaN，而 `NaN > maxDiff` 是 false —— 所以不特別處理
  // 的話，一邊算出 NaN 會讓關卡**安靜地通過**。實測踩到：體積霧的 RGB 在
  // WebGPU 上全是 NaN，而關卡報「最大差 0.000%」。
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  const absolute = Math.abs(a - b);
  if (absolute < floor) return 0;
  return absolute / Math.max(Math.abs(a), 1e-6);
};

const readEffect = async (url, handleName, key, measure) => {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.setDefaultNavigationTimeout(240000);
  await page.goto(url, { waitUntil: 'load' });
  try {
    await page.waitForFunction(
      (a) => window[a.handleName]?.[a.key] != null,
      { handleName, key },
      { timeout: 120000 },
    );
  } catch {
    const why = errors.length > 0 ? errors[0].slice(0, 300) : '（頁面沒有丟出任何錯誤）';
    await page.close();
    throw new Error(`${url} 沒有建起來：${why}`);
  }
  // 量測函式直接交給 Playwright 序列化過去 —— 兩邊跑的是同一份原始碼。
  const values = await page.evaluate(
    async (a) => {
      const api = window[a.handleName][a.key];
      const fn = new Function('return ' + a.source)();
      return fn(api);
    },
    { handleName, key, source: measure.toString() },
  );
  await page.close();
  return { values, errors };
};

try {
  for (const effect of EFFECTS) {
    console.log(`\n  ── ${effect.name} ──`);
    // 門檻／地板的鍵打錯的話那些量會靜靜掉到 default —— 在跑之前就攔下來。
    const strayKeys = [
      ...unmatchedKeys(effect.tolerance, effect.labels),
      ...unmatchedKeys(effect.floor, effect.labels),
    ];
    check(strayKeys.length === 0, `門檻的鍵都對得到量 —— ${strayKeys.join('、') || '都對得到'}`);
    const gl = await readEffect(`${base}${effect.glUrl}`, '__ww', effect.key, effect.measure);
    const gpu = await readEffect(`${base}${effect.gpuUrl}`, '__wwgpu', effect.key, effect.measure);

    check(
      gl.errors.length === 0 && gpu.errors.length === 0,
      `兩邊都沒有主控台錯誤 —— ${(gl.errors[0] ?? gpu.errors[0])?.slice(0, 120) ?? '乾淨'}`,
    );

    const pair = effect.pair ?? gl.values.map((_, i) => i);
    // ## 兩邊都真的算出東西了
    //
    // 兩邊一起全 0 的話下面每一條比對都會過 —— 那是這一類關卡最容易有的假綠。
    const smallestFloor = Math.min(
      ...gl.values.map((_, i) => perQuantity(effect.floor, i, effect.labels?.[i] ?? String(i), 1e-4)),
    );
    const spread = (v) => Math.max(...v) - Math.min(...v);
    console.log(`  值域：WebGL ${spread(gl.values).toFixed(4)}、WebGPU ${spread(gpu.values).toFixed(4)}`);
    check(
      spread(gl.values) > smallestFloor * 10 && spread(gpu.values) > smallestFloor * 10,
      '兩邊量到的東西都有變化（不是兩邊一起是常數）',
    );

    // ## 門檻也可以**每個量各自一個**
    //
    // 同一個效果裡不同的量條件數差很多。水的 `travelled` 是兩個大數相減，
    // 需要 12%；而折射後的顏色兩邊只差 0.7–3.5%，用 12% 去量它等於沒量 ——
    // 實測「吸收係數多 15%」在單一門檻下完全漏過去。
    //
    // 判斷用的是 `違反倍數 = 差 ÷ 該量的門檻`，報出來的仍然是真正的差。
    let worstRatio = 0;
    let worstDiff = 0;
    let where = '';
    let sawNaN = false;
    for (let i = 0; i < gl.values.length; i++) {
      const label = effect.labels?.[i] ?? String(i);
      const floor = perQuantity(effect.floor, i, label, 1e-4);
      const tol = perQuantity(effect.tolerance, i, label, 0.005);
      const d = difference(gl.values[i], gpu.values[pair[i]], floor);
      if (!Number.isFinite(d)) sawNaN = true;
      const ratio = d / tol;
      if (ratio > worstRatio || !Number.isFinite(d)) {
        worstRatio = ratio;
        worstDiff = d;
        where = label;
      }
      if (effect.labels !== undefined && effect.labels.length <= 120) {
        console.log(
          `  ${effect.labels[i].padEnd(10)} WebGL ${gl.values[i].toFixed(5)}  WebGPU ${gpu.values[pair[i]].toFixed(5)}  差 ${(d * 100).toFixed(3)}%（門檻 ${(tol * 100).toFixed(1)}%）`,
        );
      }
    }
    check(
      !sawNaN && worstRatio < 1,
      `每個量都在自己的門檻內 —— 最接近的是 ${where}，差 ${
        sawNaN ? '其中一邊算出 NaN' : (worstDiff * 100).toFixed(3) + '%'
      }`,
    );

    // ## 有些主張是**單邊**的
    //
    // 「兩邊一致」只證明兩份實作互相一樣，不證明任何一份是對的 —— 一起錯的
    // 話這個關卡整片綠。所以要有一條不看對方的：拿去跟 CPU 對答案。
    for (const [side, side_r] of [
      ['WebGL', gl],
      ['WebGPU', gpu],
    ]) {
      const get = (label) => {
        const at = (effect.labels ?? []).indexOf(label);
        // 找不到的話回 undefined 會讓下游算出 NaN，而 NaN 的比較一律是 false
        // —— 那會表現成「這一條紅了」，看起來像效果壞了。所以這裡直接炸。
        if (at < 0) throw new Error(`${effect.name} 沒有這個量：${label}`);
        return side_r.values[at];
      };
      for (const [ok, message] of effect.absolute?.(get) ?? []) {
        check(ok, `${side}：${message}`);
      }
    }

    if (effect.pair !== undefined) {
      // 正面驗那個對調確實存在：不對調的話差很多。
      let naive = 0;
      for (let i = 0; i < gl.values.length; i++) {
        const floor = perQuantity(effect.floor, i, effect.labels?.[i] ?? String(i), 1e-4);
        naive = Math.max(naive, difference(gl.values[i], gpu.values[i], floor));
      }
      check(
        naive > 0.2,
        `而且那個對調確實存在（不對調的話差 ${(naive * 100).toFixed(0)}%）—— 見 projectCubeToSH 的 flip`,
      );
    }
  }
} catch (error) {
  console.log('  ✗ ' + String(error?.message ?? error));
  failed++;
} finally {
  await browser.close();
  server.close();
}

console.log(failed === 0 ? '\n跨後端關卡：全過\n' : `\n有 ${failed} 項沒過\n`);
process.exit(failed === 0 ? 0 : 1);
