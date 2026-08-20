export * from './manifest.ts';

// ## 為什麼「量誤差」放在格式契約裡
//
// `.wwm` 的每一階都存了一個 `error`，而**那個數字的意思本身就是契約的一部分**
// ——`@webworld/cook` 寫進去、`@webworld/three` 讀出來拿去選階，兩邊對它的
// 定義必須一模一樣。
//
// 一開始兩邊各自算（都用 `relativeError * scale`），而那個估計值**每一階都
// 低估真值**（最多 1.48 倍）。修的時候才發現要修兩個地方 —— 而漏掉一邊的
// 症狀是「cook 過的資產比 runtime 產生的糊」，沒有任何錯誤訊息。
//
// 型別與常數擋不住這一類：兩邊都符合型別，只是意思不一樣。
export * from './geometric-error.ts';
export { innerBox, type InnerBox, type InnerBoxOptions } from './inner-box.ts';
export { splitGeometry, type SplitOptions, type SplitPiece } from './split-geometry.ts';
export {
  bakeDistanceField,
  type DistanceField,
  type DistanceFieldOptions,
} from './distance-field.ts';
export { bakeSurfaceCache, type SurfaceCache, type SurfaceCacheOptions } from './surface-cache.ts';
export {
  PageTable,
  virtualTextureSize,
  INDIRECTION_STRIDE,
  type VirtualTextureLayout,
  type PageLoad,
} from './virtual-texture.ts';
