# @web-world-engine/format

[![npm](https://img.shields.io/npm/v/@web-world-engine/format.svg)](https://www.npmjs.com/package/@web-world-engine/format)
[![授權](https://img.shields.io/npm/l/@web-world-engine/format.svg)](https://github.com/th1230/WebWorldEngine/blob/main/LICENSE)

[`@web-world-engine/three`](https://www.npmjs.com/package/@web-world-engine/three)
與 [`@web-world-engine/cook`](https://www.npmjs.com/package/@web-world-engine/cook)
之間的資產格式契約，以及只操作 TypedArray 的幾何演算法。零相依，不引用
Three.js。

```bash
npm i @web-world-engine/format
```

多數情況不需要直接安裝：`three` 與 `cook` 各自將它列為相依，`three` 也將
使用者會用到的部分轉出。直接安裝的情境為自行讀寫 `.wwm`、撰寫自己的烘焙
工具，或在 Node 中使用下列演算法。

## 相容性

| | |
| --- | --- |
| 相依 | 無 |
| 模組格式 | ESM |
| 執行環境 | 瀏覽器與 Node，無平台專屬程式碼 |
| Node | `>=22.12` |
| 型別 | 內建 `.d.ts` |

版本與 `@web-world-engine/three`、`@web-world-engine/cook` 齊步發布。三者
必須解析到同一個 major：格式契約的重點不在型別，而在欄位的語意 —— 型別
相符而語意不同時不會產生任何錯誤。

## 目錄

- [格式契約](#格式契約)
  - [`.wwm` 佈局](#wwm-佈局) · [manifest](#manifest) · [幾何誤差](#幾何誤差)
- [幾何演算法](#幾何演算法)
  - [splitGeometry](#splitgeometry) · [innerBox](#innerbox) ·
    [bakeDistanceField](#bakedistancefield) · [bakeSurfaceCache](#bakesurfacecache) ·
    [maxSurfaceDeviation](#maxsurfacedeviation)
- [虛擬貼圖頁表](#虛擬貼圖頁表)
  - [PageTable](#pagetable) · [virtualTextureSize](#virtualtexturesize)

---

## 格式契約

型別與常數，兩端共用同一份定義。

```ts
import {
  ASSET_SCHEMA_VERSION,
  MESH_MAGIC,
  MESH_HEADER_BYTES,
  VERTEX_STRIDE_BYTES,
  type AssetManifest,
  type MeshEntry,
  type LodEntry,
  type TextureEntry,
  type MaterialEntry,
  type Bounds,
} from '@web-world-engine/format';
```

| 常數 | 值 | 說明 |
| --- | ---: | --- |
| `ASSET_SCHEMA_VERSION` | `3` | 欄位或二進位佈局變動時遞增 |
| `MESH_MAGIC` | `0x314d5757` | `.wwm` 的檔頭 magic（`WWM1`） |
| `MESH_HEADER_BYTES` | `16` | 檔頭長度 |
| `VERTEX_STRIDE_BYTES` | `48` | position(3) + normal(3) + uv(2) + tangent(4) |

版本不符時解碼器拋出例外並指出處理方式。舊的 `.wwm` 配新的 runtime 會以
錯誤的 stride 讀取，位置、法線與 UV 全部錯位，而畫面不會顯示為任何可辨識
的錯誤。

### `.wwm` 佈局

```text
offset  size  欄位
0       4     magic
4       4     schemaVersion
8       4     lodCount
12      4     vertexStride（位元組）
16      -     LOD 與 collision 的資料區塊
```

區塊位置由 manifest 的 `BlockRef` 指定，不重複記於檔頭。因此載入必須先取得
manifest —— `WW.load()` 的兩個參數即為此。

所有 LOD 共用同一份頂點，切階只更換 index buffer。

### manifest

`AssetManifest` 描述一次 cook 的全部產出：

| 欄位 | 說明 |
| --- | --- |
| `schemaVersion` | 對應 `ASSET_SCHEMA_VERSION` |
| `cookerVersion` | 產生它的 cooker 版本 |
| `contentHash` | 整份 manifest 的雜湊，不含此欄位本身 |
| `meshes` / `materials` / `textures` | 各資產的區塊位置、LOD 誤差、包圍球 |
| `warnings` | cook 過程中的降級，空陣列代表無降級 |
| `stats` | 各資產的三角形數與耗時 |

`MeshEntry.material` 指向 `materials` 的 key。每個 glTF primitive 各自成為
一個 mesh 資產，而 primitive 的定義即為「一份幾何加一個材質」。

### 幾何誤差

`LodEntry.error` 是**世界單位**的幾何誤差，不是比例。選階時看的是該誤差
投影至螢幕後的像素數 —— 同樣距離下，大型與小型物件需要的細節不同。

該定義本身即為契約的一部分：`cook` 寫入、`@web-world-engine/three` 讀出後
用於選階，兩端對它的解讀必須一致。共用同一份實作（`maxSurfaceDeviation`）
確保這一點。

---

## 幾何演算法

進出皆為 `Float32Array` 與 `Uint32Array`，不接受 `BufferGeometry`、
`Object3D` 或 renderer。因此可在 Node 中測試與執行，且不會將 Three.js
帶入 cook 端的相依。

### splitGeometry

按三角形重心將幾何切成空間上的區塊。

```ts
const pieces = splitGeometry(positions, indices, { chunks: 64 });
```

**SplitOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `chunks` | `number` | `64` | 目標區塊數 |
| `minTriangles` | `number` | `64` | 單塊的三角形數下限，低於此值併入鄰居 |

回傳 `SplitPiece[]`，每塊含 `positions`、`indices` 與 `sourceVertices`。
`sourceVertices` 是新舊頂點的對應，供呼叫端以同一份對應搬移法線、UV、切線
等其他屬性 —— 這裡不處理它們，因為各屬性的分量數與型別不同。

實際塊數通常少於 `chunks`：空的格子不計入。三角形過少或幾何退化時回傳
單一區塊。

切出的區塊必須支援鎖邊界簡化，因此邊界頂點原封保留，不在此階段合併或搬動。

### innerBox

計算一個確定位於網格內部的軸對齊盒，供遮蔽剔除作為遮蔽物使用。

```ts
const box = innerBox(positions, indices, { resolution: 24, margin: 0 });
```

**InnerBoxOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `resolution` | `number` | `24` | 每軸的體素數，成本為三次方 |
| `margin` | `number` | `0` | 額外內縮的世界距離 |

太薄、破面或平面的網格回傳 `null`，呼叫端應視為「不適合作為遮蔽物」而非
錯誤。

`margin` 用於扣除 LOD 的幾何誤差：實際繪製的是簡化後的幾何，可能比原始
網格內凹，而內接盒必須連該部分也涵蓋。

### bakeDistanceField

由三角形烘焙三維距離場。

```ts
const field = bakeDistanceField(positions, indices, { resolution: 32, padding: 0.25 });
```

**DistanceFieldOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `resolution` | `number` | `32` | 每軸格數，成本為三次方 |
| `padding` | `number` | `0.25` | 外擴比例，相對於外接盒 |

回傳 `{ data, resolution, min, size }`。`data` 為每格到最近表面的距離，
內部為負值。

距離值為 chamfer 距離變換的近似，略大於真實歐氏距離。偏大的方向是安全的：
光線多走一段最多是少擋一點光，不會穿透物體。

`padding` 不可省略：貼著表面向外的光線會立即出界，而出界後沒有資料可查，
只能視為空無一物。

### bakeSurfaceCache

烘焙與距離場對齊的表面反照率，供距離場追蹤取得顏色。

```ts
const cache = bakeSurfaceCache(positions, indices, colors, { resolution: 16, padding: 0.25 });
```

**SurfaceCacheOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `resolution` | `number` | `16` | 每軸格數 |
| `padding` | `number` | `0.25` | 外擴比例，**必須與距離場相同** |
| `flat` | `[number, number, number]` | `[1, 1, 1]` | `colors` 為 `null` 時的統一色 |

儲存反照率而非光照結果：光源移動或探針重烘後，這份快取不需更新。代價是
查詢時多一次與輻照度的相乘。

### maxSurfaceDeviation

原始頂點到簡化表面的最大距離，世界單位。這是 `LodEntry.error` 的定義。

```ts
const error = maxSurfaceDeviation(sourcePositions, { positions, indices });
```

以空間格加速最近三角形查詢。逐一比對為 O(頂點數 × 三角形數)，十萬頂點對
五萬三角形即五十億次。

---

## 虛擬貼圖頁表

### PageTable

「哪一頁在圖集的哪一格」的頁表，虛擬貼圖與虛擬陰影圖共用同一份實作。

```ts
const table = new PageTable({ pageSize: 128, pagesPerSide: 64, atlasPages: 8 });

table.request(level, px, py);     // 要求某一頁
const loads = table.commit(8);    // 本幀最多換 8 頁，回傳要載入的頁
table.lookup(px, py);             // 該位置目前解析到的圖集格與階
table.indirection;                // 供著色器使用的間接查找貼圖
```

**VirtualTextureLayout**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `pagesPerSide` | `number` | 必填 | 最細階一邊的頁數，**必須是 2 的次方** |
| `pageSize` | `number` | `128` | 單頁邊長，單位為 texel |
| `atlasPages` | `number` | `16` | 圖集一邊的頁數，`atlasPages²` 為可駐留的頁數 |

| 成員 | 說明 |
| --- | --- |
| `request(level, px, py)` | 標記需要的頁，不立即載入 |
| `commit(budget = 8)` | 提交本幀的頁替換，回傳 `PageLoad[]` |
| `lookup(px, py)` | 查詢該位置目前解析到的 `{ slotX, slotY, level }` |
| `indirection` | `Uint8Array`，每格四位元組（`INDIRECTION_STRIDE`） |
| `residentCount` | 目前駐留的頁數 |
| `rootSlot` | 最粗階所在的格，永遠釘在 `(0, 0)` |
| `levels` | 階數，最細為 `0` |

`indirection` 以最細階的解析度儲存：著色器取得 UV 後乘上 `pagesPerSide`
即為查表座標，不需先決定使用哪一階。實際使用哪一階由駐留狀況決定，而這
正是回退機制。

最粗階（單頁）永遠駐留於第 0 格且不可被替換，回退鏈因此保證有底。

`pagesPerSide` 不是 2 的次方時建構即拋出例外：mip 金字塔各階的邊界會對不
齊，回退將查到相鄰頁。該錯誤僅在特定縮放比例下顯現。

### virtualTextureSize

由布局推導實際與虛擬的貼圖尺寸。

```ts
const { virtualSize, atlasSize, ratio } = virtualTextureSize(layout);
```

`virtualSize` 為 `pageSize × pagesPerSide`，`atlasSize` 為
`pageSize × atlasPages`。前者可遠超硬體上限而後者不會，兩者的比值即為此
機制的效益。

---

[變更紀錄](https://github.com/th1230/WebWorldEngine/blob/main/CHANGELOG.md) ·
[原始碼](https://github.com/th1230/WebWorldEngine/tree/main/packages/format) ·
[問題回報](https://github.com/th1230/WebWorldEngine/issues)

MIT
