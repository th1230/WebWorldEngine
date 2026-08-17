# ADR 0001：Three.js 只能位於 renderer adapter 層

狀態：已採納（M0）

## 背景

Three.js 提供 `WebGPURenderer`、TSL、compute、storage buffer、indirect draw 參數、`InstancedMesh`、`BatchedMesh` 與完整的 loader 生態。這些都值得用。

但它**沒有**提供 World Partition、Nanite 等級的幾何虛擬化、Lumen 等級的 GI、Asset Cooker，也沒有 Editor。那些是我們要自己建的部分。

最容易犯的錯是讓 `THREE.Object3D` 變成世界狀態的真實來源：

```ts
object.mesh.position.x = 10;
```

一旦如此，連續資料佈局、streaming、floating origin、GPU-driven culling 全部無從實作 —— 因為世界資料散落在一棵為了「立即渲染」而設計的場景樹裡，而不是連續的、可批次處理的陣列裡。

## 決策

Three.js 只能出現在 `internal/render-three` 與 `apps/*`。

依賴方向：

```text
apps/*  →  render-three  →  render-core  →  core
              ↑              ↑   ↑
           engine  →─────────┘   │
              ↓                  │
             ecs  →──────────────┘
                            diagnostics   ↗
                            platform-web  ↗
```

引擎邏輯操作的是資料，不是 renderer 物件：

```ts
transforms.setPosition(id, 10, 0, 0);
```

## 如何強制

寫在文件裡的規則會被違反。這條規則由 `eslint.config.js` 的 `@typescript-eslint/no-restricted-imports` 強制，CI 會擋：

- `core`：禁止 `three`、`three/*`、以及**任何** `@ww/*`（必須零 workspace 依賴）
- `platform-web`、`diagnostics`：禁止 `three`、`three/*` 與所有反向依賴
- `render-core`：禁止 `three`、`three/*`、`@ww/render-three`
- `render-three`：無限制（唯一的例外）
- `apps/*`、`tools/*`：無限制

驗證方式：在 `internal/core` 加一行 `import * as THREE from 'three'`，`pnpm lint` 必須報錯。

## 實際長什麼樣子

`@ww/diagnostics` 需要 renderer 的統計數據，但不能認識 `WebGPURenderer`。所以它定義介面：

```ts
export interface RendererTelemetry {
  readonly timestampsAvailable: boolean;
  readStats(): RendererStatsSnapshot;
  resolveGpuTimings(): Promise<GpuTimingSample>;
}
```

由 `@ww/render-three` 的 `ThreeTelemetry` 實作，把 `renderer.info` 轉成中立格式。

## 這條界線的形狀

backend 的輸入只有 `RenderFrame`：一份純資料，描述相機、instance 矩陣與燈光。
**引擎不知道 Three.js 存在。**

代價是引擎自己實作矩陣運算（`internal/core/src/mat4.ts`）。用 Three.js 的數學會讓 `@ww/engine` import three，界線從最熱的那條路徑瓦解 —— 約 200 行程式碼換一條乾淨的界線。

換得的是：換 backend 不用改引擎、引擎可以在沒有 renderer 的環境（測試、伺服器）執行。

**這是內部規則。** 對外的 `packages/three` 反而必須講 Three.js 的話 —— 使用者給 `BufferGeometry` 與 `Material`，套件回傳 `Object3D` 的子類。把內部規則套到對外介面上，等於要求使用者先把世界翻譯成引擎的語言。

## 已知的逃生門

`ThreeRenderBackend` 上有三個 benchmark 專用的出口：`submitRaw()`、`precompileRaw()`、`raw`。

benchmark 的場景量的是 **renderer 特性**（instance 吞吐、shader 編譯停頓、貼圖記憶體、indirect draw 可行性），不是引擎特性。讓它們走 `RenderFrame` 會在量測與被量測對象之間多墊一層。

**引擎程式碼不得使用這些方法**，正式路徑是 `submit(frame)`。`compute-indirect` 用 `raw` 取得 compute 能力，那代表一個尚未被抽象化的缺口 —— 建立 GPU-driven 幾何路徑時應該一併補上正式介面並移除。

## 代價

- 需要一層轉譯，多寫一些程式碼
- render extraction 需要複製資料（M1）
- 無法直接用 Three.js 生態的某些 helper（它們預設操作 `Object3D`）

這些代價是刻意付的。替代方案是等世界串流開始之後才發現整個架構要重寫。
