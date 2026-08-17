# ADR 0002：WebGPU 優先，WebGL2 是降級而非等價

狀態：已採納（M0）

## 決策

`WebGPURenderer` 在不支援 WebGPU 時會自動退回 WebGL2。我們**不**把這視為兩條等價的路徑。

`CapabilityProfile` 在 WebGL2 路徑下一律回報：

```ts
compute: false
indirectDraw: false
storageTextures: false
maxStorageBufferSize: 0
```

並且 `evaluateGates()` 直接把 WebGL2 封頂在 Tier 0。

## 理由

Compute shader、storage buffer 與 indirect draw 不是「WebGPU 的最佳化」，而是後續整套 GPU-driven 架構的地基：

- HZB occlusion culling
- meshlet culling 與 indirect rendering
- M10 的 virtual texture feedback

這些在 WebGL2 上沒有對應實作。假裝兩者相同，只會讓失敗延後到執行期才爆炸。

明確回報 `false`，呼叫端就必須自己決定要怎麼降級 —— 這才是正確的位置。

## 實測驗證

`smoke` profile（`--enable-unsafe-swiftshader`）實測落到 **WebGL2**，而非 WebGPU-on-SwiftShader。capability probe 正確回報 `backend: 'webgl2'`、`compute: false`，`compute-indirect` 場景據此跳過 indirect 路徑並記錄原因，`device-loss-soak` 回報無法模擬 device loss。

這也意味著：**煙霧測試不覆蓋 WebGPU 專屬路徑**。那些只能靠 `hardware` profile 驗證。

## 附帶結論

`renderer.highPrecision`（CPU 64-bit model-view 矩陣）目前與 `InstancedMesh`、`SkinnedMesh` 不相容。因此大世界精度不靠它，而是走 cell-local coordinates + floating origin（見 `internal/engine/src/streaming.ts`）。
