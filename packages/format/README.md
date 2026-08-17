# @webworld/format

[`@webworld/three`](https://www.npmjs.com/package/@webworld/three)（解碼）與
[`@webworld/cook`](https://www.npmjs.com/package/@webworld/cook)（產生）之間的
資產格式契約。**只有型別與常數，沒有邏輯。**

一般不需要直接安裝 —— 那兩個套件各自把它列為相依。自己讀寫 `.wwm` 或
自己寫工具時才會用到。

## 內容

```ts
ASSET_SCHEMA_VERSION   // 格式版本。cook 與 runtime 必須一致
MESH_MAGIC             // .wwm 的檔頭 magic
MESH_HEADER_BYTES      // 16
VERTEX_STRIDE_BYTES    // 48：position(3) + normal(3) + uv(2) + tangent(4)

AssetManifest, MeshEntry, LodEntry, TextureEntry, MaterialEntry, Bounds
```

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

MIT
