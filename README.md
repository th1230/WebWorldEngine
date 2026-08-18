# WebWorld Engine

> **Three.js 做得到 UE 做的那些事，但要開發者自己刻。這個專案把那一整套補上。**

用這個套件寫 Three.js，像遊戲開發者用 UE：不必鑽進底層優化，因為套件已經
做好了。它**不取代 Three.js** —— 原本的 `Scene`、`Mesh`、`Material`、loader、
controls、後處理全部照樣能用，隨時可以換回去。

```diff
- const rocks = new THREE.InstancedMesh(geometry, material, 10000);
+ const rocks = new WW.InstancedMesh(geometry, material, 10000);
  for (let i = 0; i < 10000; i++) rocks.setMatrixAt(i, matrix);
  scene.add(rocks);
```

換掉的那一行帶來螢幕誤差 LOD 與空間分割剔除。沒有初始化、沒有 `update()`、
沒有自己的 render loop。

套件本身的用法見 [`packages/three/README.md`](packages/three/README.md)。
這一份講的是**這個 repo**。

## 能力

| | 開發者能做到 | |
| --- | --- | --- |
| W1 | 換一個字，物件數 ×10 而幀時間不變 | ✅ |
| W2 | 手上只有一份 `BufferGeometry` 也有完整 LOD 鏈 | ✅ |
| W3 | 世界比記憶體大：只回答「這一格裡有什麼」 | ✅ |
| W4 | CPU 與 GPU 各自到硬體極限 | 遠景合併完成；繪製合併與遮擋剔除量過後否決 |
| W5 | 網站的指標（首次可見、下載量、分頁記憶體） | 四項都量到了 |

通過條件與每一項的實測數字見 [`specs/roadmap.md`](specs/roadmap.md)。

## 目錄

```text
packages/             會發布到 npm
  three/                @webworld/three —— runtime，裝進使用者的 Three.js 專案
  cook/                 @webworld/cook —— 離線 CLI（Node），把 glTF 烘焙成 .wwm
  format/               @webworld/format —— 上面兩個之間的格式契約（只有型別）
internal/             不發布：上面那些的實作，build 時內聯進 dist
  core/                 零依賴：型別、assert、RingBuffer、統計、矩陣
  assets-runtime/       manifest 載入、.wwm 解碼、快取與參考計數
  engine/               世界 cell 串流排程、視錐與 cell 剔除
  platform-web/         WebGPU capability 探測、Tier 分級
  diagnostics/          Profiler、幀歷史、報告、overlay
  render-core/          backend-agnostic 的 renderer 介面與 RenderFrame
  render-three/         benchmark 的 Three.js adapter
apps/
  example/              一個普通的 Three.js 專案，只換一個字
  benchmark/            量測用的 Vite app 與所有場景
tools/
  benchmark-runner/     Playwright 跑分與回歸比對
  package-check/        打包 → 裝進乾淨專案 → import
  visual-check/         畫面比對：強化版 vs 原生，掃相機角度
  site-check/           網站指標：首次可見、下載量、記憶體、與頁面共存
benchmarks/baselines/ 各機器的效能基準（進版控）
specs/                準則、里程碑、契約與 ADR
```

`packages/` 與 `internal/` 的分界是「會不會出現在使用者的 `node_modules`
裡」。`internal/*` 全部 `private: true`，build 時被內聯 —— 一起發布的話
使用者會看到一堆 `@ww/*`，而那些是實作細節不是介面。

三個發布的套件分工是刻意的：`cook` 的相依（sharp、gltf-transform）**絕不能
出現在瀏覽器的 bundle 裡**，而同一個套件同時提供 runtime 與 cook 就得靠
tree-shaking 保證那件事 —— 那是一個壞掉時完全沒有徵兆的保證。

`apps/` 兩個都不是產品：`example` 是證明，`benchmark` 是儀器。

## 依賴方向

```text
apps/example    →  three  →  engine ─┬→ core
                        →  format ──┘
apps/benchmark  →  three
                →  render-three  →  render-core  →  core
                                    diagnostics  ↗
                                    platform-web ↗
cook（Node，離線）→  format  →  （無）
```

**Three.js 只能出現在 `packages/three`、`internal/render-three` 與 `apps/*`。**
這條規則由 `eslint.config.js` 強制。想確認它有效，在 `internal/core` 任一
檔案加上 `import * as THREE from 'three'`，`pnpm lint` 必須報錯。

引擎核心與 renderer 解耦是**內部**規則（資料才排得成 SoA）。對外介面反而
必須講 Three.js 的話 —— 使用者給 `BufferGeometry` 與 `Material`，套件回傳
`Object3D` 的子類。見 [ADR 0001](specs/adr/0001-three-as-adapter.md) 與
[`specs/api.md`](specs/api.md)。

## 開發

```bash
pnpm install
pnpm verify     # typecheck + lint + test
pnpm example    # 範例 app，http://localhost:5174/
pnpm build:pkg  # 建置三個發布套件的 dist
pnpm site-check # 網站指標（首次可見、下載量、記憶體、與頁面共存）
```

## 四道關卡，一個指令

```bash
pnpm verify:all
```

| | 擋什麼 | 需要 |
| --- | --- | --- |
| `pnpm verify` | 型別、lint、500 個單元測試 | — |
| `pnpm package-check` | 打包 → 裝進乾淨專案 → 在瀏覽器裡跑起來 | 瀏覽器 |
| `pnpm site-check` | 首次可見、下載量、記憶體、與頁面共存、看不見時要停 | 瀏覽器 |
| `pnpm visual-check` | 畫面與原生版的差異，四個模式各掃八個角度 | 瀏覽器 |

**後面三道不在 `pnpm verify` 裡**，因為它們要建 app 跟開瀏覽器。而這一輪
最嚴重的兩個 bug 都是「有量、沒有人擋」——分頁記憶體漲到 1 GB、畫面比對
從來沒被跑過。所以它們現在有一個統一的入口，不必記四個指令。

`node tools/package-check/verify.mjs` 把三個套件打包、裝進一個乾淨專案，
import 之後真的跑一次 cook 並檢查產出的 `.wwm`，最後把它打包成一個網站在
瀏覽器裡跑起來。工作區裡 `exports` 直指 `src/`，所以其餘檢查全部碰不到
`dist` —— 打包壞掉只有這個檢查抓得到。CI 會跑它。

最後那一段刻意只 serve 打包產出，不讓 `node_modules` 被讀到 —— 那才是使用者
網站的樣子。worker 若靠路徑解析，就是在這裡 404。

## Benchmark

```bash
pnpm dev             # 互動式，http://localhost:5173/?scene=instancing
pnpm cook:real       # 烘 assets/source/props，ab-*-real 場景需要
pnpm cook:sponza     # 烘 Sponza，occlusion-sponza 場景需要
pnpm bench           # 真實 GPU 跑完所有場景（每場景 3 次取中位數）
pnpm bench:baseline  # 存成這台機器的基準
pnpm bench:compare   # 與基準比對，退步超過門檻就非零離開
pnpm bench:variance  # 從歷次執行推導雜訊水準與建議門檻
pnpm bench:smoke     # 無頭 + SwiftShader，只驗證跑不跑得起來
```

門檻由 `bench:variance` 從實測雜訊推導，不要手動猜 —— 猜太緊會天天誤報
然後被忽略，那比沒有門檻更糟。`bench:smoke` 的效能數字無意義。

`ab-*-real` 用的是真實資產，需要先把 `.glb` 放進 `assets/source/props/`
再跑 `pnpm cook:real`。合成內容在兩個方向上都不具代表性 —— 非索引幾何讓
幾何看起來貴 3.35 倍，沒有貼圖讓材質看起來免費（真實 PBR 是 1.72 倍）——
所以只用它量出來的 CPU/GPU 佔比會把後續每一個決策帶往錯的方向。

場景定義與量測協定見 [`specs/benchmark.md`](specs/benchmark.md)。

## 先讀哪一份

| | |
| --- | --- |
| [`specs/doctrine.md`](specs/doctrine.md) | **判斷一件事該不該做、做完了沒有。動手之前先讀。** |
| [`specs/roadmap.md`](specs/roadmap.md) | 里程碑、通過條件與實測數字 |
| [`specs/api.md`](specs/api.md) | 使用者實際會寫的程式碼 |
| [`specs/benchmark.md`](specs/benchmark.md) | 場景與量測協定 |

## 範圍

桌機瀏覽器的 WebGPU，WebGL2 作為 fallback。**行動裝置不在範圍內** ——
不是「還沒做」，是無法驗證：ETC2／ASTC 沒有任何桌機能解碼，寫出來的編碼器
只能用自己的解碼器驗，那證明不了任何事。重新納入的前提是先有一台能跑 CI
的實機。

## 慣例

- 文件、ADR、註解用**繁體中文**；程式碼識別字、型別、API 命名、commit 用**英文**
- 內部 package 不做 build step，`exports` 直指 `src/index.ts`（[ADR 0003](specs/adr/0003-source-only-packages.md)）
- TypeScript 開到很嚴：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`
- 效能報告以 p50 / p95 / p99 為主，不用平均值 —— 平均值會把 stutter 藏起來
- 量不到的數值回報 `null`，不要回報 `0`
- 效能結論必須註明用什麼內容量的
- 驗證正確性的場景要提供 `verdict()`，讓 runner 自動判定
- 涵蓋不到不等於通過：驗不到的路徑要明說「未驗證」

## 環境需求

Node.js ≥ 22.12、pnpm 11、支援 WebGPU 的桌機瀏覽器。

`pnpm bench` 若找不到瀏覽器：`pnpm exec playwright install chromium`

MIT
