# internal/ —— 不發布的實作

這一層的每一個套件都是 `private: true`，**永遠不會出現在 npm 上**。

它們是 `packages/*` 那三個套件的實作，build 時被內聯進各自的 `dist`。
把它們一起發布的話，使用者的 `node_modules` 裡會出現一堆 `@ww/*` ——
那些是實作細節，不是介面。

| | |
| --- | --- |
| `core` | 零依賴：型別、assert、RingBuffer、統計、固定步長、矩陣 |
| `assets-runtime` | manifest 載入、`.wwm` 解碼、快取與參考計數 |
| `engine` | transform 階層、剔除、LOD 選擇、world cell 串流排程 |
| `platform-web` | WebGPU capability 探測、Tier 分級、device-lost 恢復 |
| `diagnostics` | Profiler、幀歷史、報告、overlay |
| `render-core` | backend-agnostic 的 renderer 介面與 `RenderFrame` |
| `render-three` | Three.js adapter（只有 benchmark 用） |


## 依賴方向由 lint 強制

`eslint.config.js` 針對這一層每個套件各有一條規則。想確認它有效，
在 `internal/core` 任一檔案加上 `import * as THREE from 'three'`，
`pnpm lint` 必須報錯。
