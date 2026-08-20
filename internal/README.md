# internal/

不發布的實作層。每個套件都是 `private: true`，不會出現在 npm 上 ——
它們在 build 時被內聯進 `packages/*` 各自的 `dist`。

一併發布會讓使用者的 `node_modules` 出現一批 `@ww/*`，而那些是實作細節，
不是介面。

| | |
| --- | --- |
| `core` | 零相依：型別、assert、RingBuffer、統計、固定步長、矩陣 |
| `assets-runtime` | manifest 載入、`.wwm` 解碼、快取與參考計數 |
| `engine` | transform 階層、剔除、LOD 選擇、world cell 串流排程 |
| `platform-web` | WebGPU capability 探測、Tier 分級、device-lost 恢復 |
| `diagnostics` | Profiler、幀歷史、報告、overlay |
| `render-core` | 與後端無關的 renderer 介面與 `RenderFrame` |
| `render-three` | Three.js adapter，僅 benchmark 使用 |

## 依賴方向由 lint 強制

`eslint.config.js` 針對這一層每個套件各有一條規則。確認它有效的方式：在
`internal/core` 任一檔案加上 `import * as THREE from 'three'`，`pnpm lint`
必須報錯。

內部套件不做 build step，`exports` 直指 `src/index.ts`
（[ADR 0003](../specs/adr/0003-source-only-packages.md)）。
