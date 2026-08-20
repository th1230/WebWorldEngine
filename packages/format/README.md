# @webworld/format

[`@webworld/three`](https://www.npmjs.com/package/@webworld/three)（解碼、執行期）與
[`@webworld/cook`](https://www.npmjs.com/package/@webworld/cook)（產生、離線）
之間共用的那一層。**零相依，而且不認識 Three.js。**

一般不需要直接安裝 —— 那兩個套件各自把它列為相依。自己讀寫 `.wwm`、
自己寫烘焙工具，或想在 Node 裡跑那幾個演算法時才會用到。

```bash
npm i @webworld/format
```

## 兩種東西，同一個理由

裡面有兩類內容，而它們在這裡的理由不一樣：

**一、格式契約 —— 因為兩邊都要用同一個定義**

```ts
ASSET_SCHEMA_VERSION   // 格式版本。cook 與 runtime 必須一致
MESH_MAGIC             // .wwm 的檔頭 magic
MESH_HEADER_BYTES      // 16
VERTEX_STRIDE_BYTES    // 48：position(3) + normal(3) + uv(2) + tangent(4)

AssetManifest, MeshEntry, LodEntry, TextureEntry, MaterialEntry, Bounds
```

以及**「誤差」這個數字的定義**（`geometric-error.ts`）。`.wwm` 的每一階都
存了一個 `error`，cook 寫進去、runtime 讀出來拿去選階 —— 那個數字的意思
本身就是契約的一部分。

一開始兩邊各自算（都用 `relativeError * scale`），而那個估計值**每一階都
低估真值**（最多 1.48 倍）。修的時候才發現要修兩個地方，而漏掉一邊的症狀是
「cook 過的資產比 runtime 產生的糊」，沒有任何錯誤訊息。

型別與常數擋不住這一類：兩邊都符合型別，只是意思不一樣。

**二、純演算法 —— 因為它們只碰原始的 TypedArray**

```ts
splitGeometry(positions, indices, options)   // 切塊，鎖邊界
innerBox(positions, indices)                 // 內接盒（遮蔽剔除用）
bakeDistanceField(positions, indices, opts)  // 三維距離場
bakeSurfaceCache(...)                        // 距離場配的表面顏色
PageTable, virtualTextureSize                // 虛擬貼圖的頁表與尺寸推導
```

這幾個不吃 `BufferGeometry`、不吃 `Object3D`、不吃 renderer —— 進去是
`Float32Array` 與 `Uint32Array`，出來也是。所以它們放在這裡：

- **測得起來**：不必開瀏覽器、不必造 Three 的物件
- **Node 裡跑得動**：寫自己的離線工具時直接 import
- **不會把 Three 拖進 cook**：`cook` 的相依（sharp、gltf-transform）絕不能
  出現在瀏覽器的 bundle 裡，而反向也一樣

目前只有 `@webworld/three` 在用它們（`cook` 還沒有需要）。那不代表它們該搬
去 `three` —— 一搬過去就得吃 Three 的型別，上面三件事同時失去。

## 為什麼是獨立的套件

兩邊各自內聯一份的話，`ASSET_SCHEMA_VERSION` 會悄悄分岔 —— 而症狀是
「cook 完載不進去」，訊息指向錯的方向。

拆成一個共用的套件之後，npm 的版本解析就是那個契約的守門員：
兩個工具解析到不同的 major，安裝當下就會被擋下來。

## `.wwm` 的佈局

```text
offset  size  欄位
0       4     magic
4       4     schemaVersion
8       4     lodCount
12      4     vertexStride（位元組）
16      -     LOD 與 collision 的資料區塊
```

區塊位置由 manifest 的 `BlockRef` 指定，**不重複記在檔頭裡** —— 兩份真相
遲早會不一致。所以載入一定要先有 manifest。

所有 LOD **共用同一份頂點**，切階只換 index buffer。

## 虛擬貼圖的頁表

`PageTable` 是「哪一頁在圖集的哪一格」那張表，虛擬貼圖與虛擬陰影圖共用
同一份實作。

```ts
const table = new PageTable({ pageSize: 128, pagesPerSide: 64, atlasPages: 8 });
table.request(level, px, py);          // 我要這一頁
const loads = table.commit(8);         // 這一幀最多換 8 頁，回傳要載哪幾頁
table.lookup(px, py);                  // 這個位置現在解析到圖集的哪一格、哪一階
table.indirection;                     // 給著色器的那張間接查找貼圖
```

`pagesPerSide` **必須是 2 的次方** —— 不是的話建構時直接丟例外，訊息裡寫著
原因：mip 金字塔每一階的邊界會對不齊，回退就會查到隔壁頁。那種錯只在特定
縮放比例下露出來，所以擋在建構當下而不是讓它靜靜地錯。

MIT
