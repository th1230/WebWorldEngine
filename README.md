# WebWorld Engine

[![CI](https://github.com/th1230/WebWorldEngine/actions/workflows/ci.yml/badge.svg)](https://github.com/th1230/WebWorldEngine/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@web-world-engine/three.svg)](https://www.npmjs.com/package/@web-world-engine/three)
[![授權](https://img.shields.io/npm/l/@web-world-engine/three.svg)](LICENSE)

Three.js 的大世界工具集：螢幕誤差 LOD、空間分割剔除、內容串流，以及陰影、
間接光、反射、地形與水的實作。

不取代 Three.js —— `Scene`、`Mesh`、`Material`、loader、controls 與後處理
全部照常使用，可隨時換回原生類別。

```diff
- const rocks = new THREE.InstancedMesh(geometry, material, 10000);
+ const rocks = new WW.InstancedMesh(geometry, material, 10000);
  for (let i = 0; i < 10000; i++) rocks.setMatrixAt(i, matrix);
  scene.add(rocks);
```

換掉的這一行帶來螢幕誤差 LOD 與空間分割剔除，不需要初始化、`update()`
或自訂的 render loop。

## 套件

| | | |
| --- | --- | --- |
| [`@web-world-engine/three`](packages/three) | runtime，裝進使用者的 Three.js 專案 | [![npm](https://img.shields.io/npm/v/@web-world-engine/three.svg)](https://www.npmjs.com/package/@web-world-engine/three) |
| [`@web-world-engine/cook`](packages/cook) | 離線 CLI（Node），把 glTF 烘焙成 `.wwm` | [![npm](https://img.shields.io/npm/v/@web-world-engine/cook.svg)](https://www.npmjs.com/package/@web-world-engine/cook) |
| [`@web-world-engine/format`](packages/format) | 兩者共用的格式契約與純演算法 | [![npm](https://img.shields.io/npm/v/@web-world-engine/format.svg)](https://www.npmjs.com/package/@web-world-engine/format) |

API 說明見 [`packages/three/README.md`](packages/three/README.md)。以下是這個
repo 本身的說明。

## 目錄

- [開發](#開發) · [驗證](#驗證) · [Benchmark](#benchmark)
- [儲存庫結構](#儲存庫結構) · [依賴方向](#依賴方向)
- [分支與發布](#分支與發布) · [版本規則](#版本規則)
- [文件](#文件) · [範圍](#範圍) · [慣例](#慣例)

## 開發

需要 Node.js ≥ 22.12、pnpm 11，以及支援 WebGPU 的桌機瀏覽器。

```bash
pnpm install
```

| 指令 | 說明 |
| --- | --- |
| `pnpm verify` | typecheck、lint、格式、單元測試，加上五道不需瀏覽器的關卡 |
| `pnpm verify:all` | 上者加上二十二道需要瀏覽器的關卡 |
| `pnpm example` | 範例 app，<http://localhost:5174/> |
| `pnpm dev` | benchmark app，<http://localhost:5173/> |
| `pnpm build:pkg` | 建置三個發布套件的 `dist` |
| `pnpm format` | 以 Prettier 寫回（不含 `.md`，spec 的表格是手排的） |

日常在 `develop` 上開發，經 PR 合併回 `main`；合併到 `main` 即觸發發布。

## 驗證

```bash
pnpm verify:all
```

這個專案的主要風險不是「會不會壞」，而是壞掉時沒有訊號：一個沒接上的效果
不會報錯，幀時間反而更好看；一個少剔除的參數不會報錯，只是慢；一個靜態
import 不會報錯，只是每個使用者多下載一包。二十七道關卡各自守住一項不會
自己顯現的事實。

### 不需瀏覽器

| | 擋什麼 |
| --- | --- |
| `pnpm metadata-check` | npm 頁面上的欄位：description、repository、進入點指向 `dist` |
| `pnpm docs-check` | README 寫的 API 真的存在，且每個公開功能都寫到了 |
| `pnpm bundle-check` | 只用 WebGL 的專案不應下載 WebGPU 的部分 |
| `pnpm publish-check` | 發布出去的形狀（publint + are-the-types-wrong） |
| `pnpm ci-check` | workflow 的語法、script 名稱，以及職責是否重疊 |

### 需要瀏覽器

| | 擋什麼 |
| --- | --- |
| `pnpm package-check` | 打包 → 裝進乾淨專案 → 實際使用一次 |
| `pnpm site-check` | 首次可見、下載量、分頁記憶體、與頁面共存、看不見時停止 |
| `pnpm visual-check` | 與原生 Three.js 的畫面差異，七個模式各掃八個角度 |
| `pnpm gpu-check` | 實際 GPU 時間與原生版的比較，兩種內容 |
| `pnpm webgpu-check` | 頂點動畫在 WebGPU 的 node 材質上確實在動 |
| `pnpm physics-check` | 物件踩在畫出來的地面上、浮在畫出來的水面上 |
| `pnpm gi-check` | 背光面的光確實來自紅牆的反彈，兩個後端都驗 |
| `pnpm ssgi-check` | 螢幕空間間接光確實產生作用 |
| `pnpm impostor-check` | Impostor 對真幾何的效能與相似度 |
| `pnpm vt-check` | 虛擬貼圖畫的是正確的那一頁 |
| `pnpm daynight-check` | 太陽移動的代價：整份探針重烘的時間 |
| `pnpm contact-check` | 接觸陰影落在接縫上，而非整片變暗 |
| `pnpm df-shadow-check` | 距離場陰影在遠處仍有形狀 |
| `pnpm reflect-check` | 反射涵蓋畫面外的物件 |
| `pnpm sky-check` | 天空的顏色是積分結果，且會餵給間接光 |
| `pnpm lod-fade-check` | 換階抖動不在畫面上開洞 |
| `pnpm fog-check` | 光柱被遮蔽物擋住，不穿牆 |
| `pnpm vsm-check` | 虛擬陰影圖的等效解析度確實大於圖集 |
| `pnpm shadow-lod-check` | 陰影 pass 自行剔除與選階 |
| `pnpm reflprobe-check` | 反射中有實際拍到的內容，且隨串流更新 |
| `pnpm water-look-check` | 水的每一項外觀都由水深推導 |
| `pnpm cross-check` | 同一效果在兩個後端算出同一組數字 |

每道關卡執行前先檢查產物是否過期（原始碼比 `dist` 新即中止）。過期的產物
會給出有信心的錯誤答案，比沒有關卡更糟。

判準的訂定方式見 [`specs/doctrine.md`](specs/doctrine.md)。

## Benchmark

```bash
pnpm dev             # 互動式，http://localhost:5173/?scene=instancing
pnpm cook:real       # 烘焙 assets/source/props，ab-*-real 場景需要
pnpm cook:sponza     # 烘焙 Sponza，occlusion-sponza 場景需要
pnpm bench           # 真實 GPU 執行所有場景（每場景 3 次取中位數）
pnpm bench:baseline  # 存為這台機器的基準
pnpm bench:compare   # 與基準比對，退步超過門檻即非零離開
pnpm bench:variance  # 由歷次執行推導雜訊水準與建議門檻
pnpm bench:smoke     # 無頭 + SwiftShader，僅驗證可執行
```

門檻由 `bench:variance` 從實測雜訊推導，不要手動估計 —— 過緊的門檻會天天
誤報而後被忽略。`bench:smoke` 的效能數字不具意義。

`ab-*-real` 使用真實資產，需先將 `.glb` 放入 `assets/source/props/` 再執行
`pnpm cook:real`。合成內容在兩個方向上都不具代表性：非索引幾何讓幾何成本
看起來高 3.35 倍，缺少貼圖讓材質看起來免費（真實 PBR 為 1.72 倍）。

場景定義與量測協定見 [`specs/benchmark.md`](specs/benchmark.md)。

## 儲存庫結構

```text
packages/             發布到 npm
  three/                runtime
  cook/                 離線 CLI
  format/               格式契約與純演算法
internal/             不發布，build 時內聯進 dist
  core/                 零相依：型別、assert、RingBuffer、統計、矩陣
  assets-runtime/       manifest 載入、.wwm 解碼、快取與參考計數
  engine/               世界 cell 串流排程、視錐與 cell 剔除
  platform-web/         WebGPU capability 探測與分級
  diagnostics/          Profiler、幀歷史、報告、overlay
  render-core/          與後端無關的 renderer 介面與 RenderFrame
  render-three/         benchmark 的 Three.js adapter
apps/
  example/              一般的 Three.js 專案，只換一個字
  benchmark/            量測用的 Vite app 與所有場景
tools/
  lib/                  關卡共用的伺服器、瀏覽器、報告、產物新舊檢查
  gpu-check/            多數畫面關卡（一個效果一支）
  benchmark-runner/     Playwright 跑分與回歸比對
  package-check/        打包 → 裝進乾淨專案 → import
  visual-check/         畫面比對：本套件對原生，掃相機角度
  site-check/           網站指標：首次可見、下載量、記憶體、與頁面共存
  bundle-check/         WebGL 專案不應下載 WebGPU 的部分
  docs-check/           README 的 API 存在性與訊息前綴
  gi-check/  physics-check/   間接光與物理的證明場景
benchmarks/baselines/ 各機器的效能基準（進版控）
specs/                準則、里程碑、契約與 ADR
```

`packages/` 與 `internal/` 的分界是「會不會出現在使用者的 `node_modules`
裡」。`internal/*` 全部 `private: true`，build 時內聯 —— 一併發布會讓使用者
看到一批 `@ww/*`，而那些是實作細節。

三個發布套件的分工是刻意的：`cook` 的相依（sharp、gltf-transform）不能出現
在瀏覽器的 bundle 裡。同一個套件同時提供 runtime 與 cook 就得靠 tree-shaking
保證這件事，而那是一個失效時沒有訊號的保證。

`apps/` 兩者都不是產品：`example` 是證明，`benchmark` 是儀器。

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

Three.js 只能出現在 `packages/three`、`internal/render-three` 與 `apps/*`，
由 `eslint.config.js` 強制。在 `internal/core` 任一檔案加上
`import * as THREE from 'three'`，`pnpm lint` 必須報錯。

引擎核心與 renderer 解耦是內部規則，資料才排得成 SoA。對外介面則必須使用
Three.js 的型別：使用者提供 `BufferGeometry` 與 `Material`，套件回傳
`Object3D` 的子類。見 [ADR 0001](specs/adr/0001-three-as-adapter.md) 與
[`specs/api.md`](specs/api.md)。

## 分支與發布

```text
develop  ──●──●──●──────●──          日常開發，PR 觸發 CI
                         ╲
main     ────────────────●──         合併即為「發布」這個決定
                         │
                         └─ release.yml：npm publish → 打 v0.2.0
```

發版流程，在 `develop` 上：

```bash
pnpm version:set 0.2.0        # 三個 package.json 一起改
#  更新 CHANGELOG.md
git commit -am "release: v0.2.0"
```

然後開 PR 合併回 `main`。

驗證與發布的職責是分開的。PR 的 CI 測試的是**合併預覽樹**，也就是合併之後
的結果；合併本身不產生新的程式碼狀態，因此 `release.yml` 不重複驗證。它只
負責發布：npm publish，成功後補上 `v0.2.0` 這個 tag，使 npm 上的版本對得回
一個 commit。

合併不會重複發布：發布前先查詢 registry 是否已有該版本，有則跳過。版本號
沒動的合併不會發布任何東西。

三個套件齊步發布。`@web-world-engine/format` 是另外兩者之間的格式契約，而
契約的重點不在型別而在語意：兩端解析到不同版本時型別全部相符，只是語意
不同，結果是 cook 過的資產比 runtime 產生的糊，且不會出現錯誤訊息。因此
有時會發出一個內容未變的版本。

> `release.yml` 需要 repo 的 `NPM_TOKEN` secret。

### Provenance

pnpm 每次發布都會先嘗試 OIDC（Trusted Publishing），失敗才退回 token。
0.1.0 退回了 token，因此沒有 provenance —— npmjs.com 上尚未替這三個套件
設定。

設定完成後 OIDC 會通過，sigstore 簽章隨之產生，將 tarball 綁定到確切的
commit 與 workflow run。屆時 `NPM_TOKEN` 可以移除。版本不可變，0.1.0 無法
補上。

### 版本規則

| | |
| --- | --- |
| 三個套件永遠同版本 | `metadata-check` 守著；`version:set` 一次改三個 |
| tag 由發布結果產生 | 發布成功才打 tag，未發布時不打 |
| 預發布走 dist-tag | `0.2.0-beta.1` → `beta`，不會覆蓋 `latest` |
| 重跑是安全的 | registry 上已有的跳過，只補未發成的 |

`npm publish` 不看版本號中的 prerelease 標記，未指定 `--tag` 一律寫入
`latest`。dist-tag 由版本號推導，不依賴人工加參數。

### `three` 的版本鎖

`packages/three` 將 `three` 的 peer 範圍鎖在單一 minor。原因是
`three-internals.ts` 使用 `THREE.BatchedMesh` 的私有欄位 —— 官方沒有公開的
替代路徑。

結構改變會在建構時報錯（`assertBatchedMeshInternals`）。上界擋的是另一種
情況：欄位名稱與型別都沒變、意思變了。那種變動沒有自動檢查抓得到，唯一的
驗證是以原生 Three.js 作為對照組的那批關卡，而它們只跑過一個版本。

代價是 Three.js 每出一個 minor 就要發一版。上游變動由
[Dependabot](.github/dependabot.yml) 偵測：新版落在範圍外時開 PR，而該 PR
的 CI 就是「這一版還能不能用」的答案。

## 文件

| | |
| --- | --- |
| [`specs/doctrine.md`](specs/doctrine.md) | 判斷一件事該不該做、做完了沒有。動手之前先讀 |
| [`specs/roadmap.md`](specs/roadmap.md) | 里程碑、通過條件與實測數字 |
| [`specs/api.md`](specs/api.md) | 使用者實際會寫的程式碼 |
| [`packages/three/README.md`](packages/three/README.md) | 對外的 API 說明 |
| [`CHANGELOG.md`](CHANGELOG.md) | 每一版的變更與遷移方式 |
| [`specs/benchmark.md`](specs/benchmark.md) | 場景與量測協定 |

## 範圍

桌機瀏覽器的 WebGPU，WebGL2 作為 fallback。

行動裝置不在範圍內，原因是無法驗證：ETC2 與 ASTC 沒有任何桌機能解碼，寫出
來的編碼器只能用自己的解碼器驗證。重新納入的前提是先有一台能跑 CI 的實機。

## 慣例

- 文件、ADR、註解用繁體中文；程式碼識別字、型別、API 命名與 commit 用英文
- 內部 package 不做 build step，`exports` 直指 `src/index.ts`（[ADR 0003](specs/adr/0003-source-only-packages.md)）
- TypeScript：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`
- 效能報告以 p50 / p95 / p99 為主，不用平均值 —— 平均值會掩蓋 stutter
- 量不到的數值回報 `null`，不回報 `0`
- 效能結論必須註明用什麼內容量的
- 驗證正確性的場景要提供 `verdict()`，供 runner 自動判定
- 涵蓋不到不等於通過：驗不到的路徑要明說「未驗證」

找不到瀏覽器時：`pnpm exec playwright install chromium`

MIT
