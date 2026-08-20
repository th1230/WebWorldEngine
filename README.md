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
pnpm verify       # typecheck + lint + format + 807 個單元測試
pnpm verify:all   # 上面那個，加上二十五道要瀏覽器的關卡
pnpm example      # 範例 app，http://localhost:5174/
pnpm dev          # benchmark app，http://localhost:5173/
pnpm build:pkg    # 建置三個發布套件的 dist
pnpm format       # prettier 寫回去（.md 不在範圍內，spec 的表格是手排的）
```

## 一個指令，二十七道關卡

```bash
pnpm verify:all
```

這個專案的核心問題不是「會不會壞」，是**壞掉的時候看不出來**。一個沒接上的
效果不報錯、幀時間還特別好看；一個少剔除的旋鈕不報錯、只是慢；一個靜態
import 不報錯、只是每個使用者多下載一包。所以每一道關卡守的都是**一句沒有
人會去量的話**。

### 不用瀏覽器

| | 擋什麼 |
| --- | --- |
| `pnpm verify` | 型別、lint、格式、807 個單元測試 |
| `pnpm metadata-check` | npm 頁面上看得到的欄位（description、repository、進入點在 dist） |
| `pnpm docs-check` | README 裡寫的 API 真的存在，而且每個公開功能都寫到了 |
| `pnpm bundle-check` | 只用 WebGL 的人不該下載 WebGPU 那一半 |

### 要瀏覽器

| | 擋什麼 |
| --- | --- |
| `pnpm package-check` | 打包 → 裝進乾淨專案 → 真的用一次 |
| `pnpm site-check` | 首次可見、下載量、分頁記憶體、與頁面共存、看不見要停 |
| `pnpm visual-check` | 畫面與原生版的差異，七個模式各掃八個角度 |
| `pnpm gpu-check` | **真的 GPU 時間**與原生版的比較，兩種內容 |
| `pnpm webgpu-check` | 頂點動畫在 WebGPU／node 材質上有沒有真的在動 |
| `pnpm physics-check` | 東西真的踩在畫出來的地面上、浮在畫出來的水面上 |
| `pnpm gi-check` | 背光面的光**是從紅牆反彈過來的**，兩個後端都要 |
| `pnpm ssgi-check` | 螢幕空間間接光到底有沒有在做事 |
| `pnpm impostor-check` | Impostor 對真幾何：快多少，以及像不像 |
| `pnpm vt-check` | 虛擬貼圖畫的是**對的那一頁**嗎 |
| `pnpm daynight-check` | 太陽移動的代價：整份探針重烘要多久 |
| `pnpm contact-check` | 接觸陰影暗的地方在接縫上，不是整片 |
| `pnpm df-shadow-check` | 距離場陰影遠處也要有形狀 |
| `pnpm reflect-check` | 反射照得到**畫面外**的東西 |
| `pnpm sky-check` | 天空的顏色是積分出來的，而且會餵給間接光 |
| `pnpm lod-fade-check` | 換階抖動不可以在畫面上開洞 |
| `pnpm fog-check` | 光柱要被擋住，不可以穿牆 |
| `pnpm vsm-check` | 虛擬陰影圖的解析度要真的比圖集大 |
| `pnpm shadow-lod-check` | 陰影 pass 自己剔除、自己選階 |
| `pnpm reflprobe-check` | 反射裡要有**實際拍到的東西**，而且跟著串流更新 |
| `pnpm water-look-check` | 水的每一項都從「有多深」推得出來 |
| `pnpm cross-check` | **同一個效果，兩個後端，必須算出同一組數字** |

### 三件學到的事

**一、有量、沒有人擋，等於沒量。** 這一輪最嚴重的兩個 bug —— 分頁記憶體漲到
1 GB、畫面比對從來沒被跑過 —— 兩個都有工具量得出來，只是沒有人跑。所以現在
只有一個入口。

**二、關卡吃的是產物，產物過期就全部無效。** 每一道都先 `assertDistFresh`：
原始碼比 `dist` 新就**直接停**，不是警告。舊產物給的是有信心的錯誤答案，
那比沒有關卡更糟。

**三、關卡自己也會壞，而且壞得看不出來。** 一道關卡可能結構上就看不到它
名字裡那件事 —— 比對上游而 bug 在下游、用一個天生免疫的指標、測試場景
分不出兩種成因。這一輪有五個上線中的 bug 是先**重寫量測**才找出來的。
判準怎麼訂見 [`specs/doctrine.md`](specs/doctrine.md)。
## 發布

三個套件**齊步發布**，版本永遠相同：

```bash
pnpm version:set 0.2.0        # 三個 package.json 一起改
#  寫 CHANGELOG.md
git commit -am "release: v0.2.0"
git tag v0.2.0 && git push --follow-tags
```

tag 推上去之後 `.github/workflows/release.yml` 會跑完整驗證（含
`package-check`：打包 → 裝進乾淨專案 → 真的用一次）再發布。

**齊步是刻意的。** `@webworld/format` 是另外兩個之間的格式契約，而契約
裡最重要的東西不是型別，是**意思** —— 兩邊解析到不同版本的話型別全部符合，
只是意思不一樣，症狀是「cook 過的資產比 runtime 產生的糊」而且沒有錯誤訊息。
所以有時候會發一個「這個套件什麼都沒改」的版本，那個代價是刻意付的。

`release.yml` 的第一步是**比對 tag 與 `package.json`**。不一致就停 ——
發錯版本號這件事事後無法修正，npm 上的版本號拿不回來。

> 這個 workflow 需要 repo 的 `NPM_TOKEN` secret。沒設的話最後一步會失敗，
> 前面的驗證照跑 —— 不會誤發。

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
| [`packages/three/README.md`](packages/three/README.md) | **對外的那一份** —— 套件裡有什麼、怎麼用 |
| [`CHANGELOG.md`](CHANGELOG.md) | 每一版改了什麼，破壞性變更怎麼遷移 |
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
