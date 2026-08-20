# @web-world-engine/cook

[![npm](https://img.shields.io/npm/v/@web-world-engine/cook.svg)](https://www.npmjs.com/package/@web-world-engine/cook)
[![授權](https://img.shields.io/npm/l/@web-world-engine/cook.svg)](https://github.com/th1230/WebWorldEngine/blob/main/LICENSE)

離線資產管線：把 glTF 烘焙成
[`@web-world-engine/three`](https://www.npmjs.com/package/@web-world-engine/three)
載入的格式 —— LOD 鏈、MikkTSpace 切線、BC 壓縮貼圖與碰撞網格。

```bash
npm i -D @web-world-engine/cook
npx ww-cook ./assets --out ./public/cooked
```

```js
import * as WW from '@web-world-engine/three';

const rock = await WW.load('/cooked/assets.manifest.json', 'mesh:rock');
scene.add(new WW.InstancedMesh(rock, material, 10000));
```

## 相容性

| | |
| --- | --- |
| Node | `>=22.12` |
| 模組格式 | ESM |
| 原生相依 | `sharp` 有平台專屬 binary |
| 型別 | 內建 `.d.ts` |

版本與 `@web-world-engine/three`、`@web-world-engine/format` 齊步發布，三者
必須解析到同一個 major。版本分岔時 cook 過的資產會載不進去，錯誤訊息會
指出 schema 版本。

## 目錄

- [是否需要 cook](#是否需要-cook)
- [命令列](#命令列)
  - [選項](#選項) · [輸出](#輸出) · [可重現性](#可重現性)
- [烘焙的內容](#烘焙的內容)
  - [LOD 鏈](#lod-鏈) · [切線](#切線) · [貼圖](#貼圖) · [碰撞網格](#碰撞網格)
- [不支援的功能](#不支援的功能)
- [程式介面](#程式介面)
  - [cookAll](#cookall) · [importGltf](#importgltf) · [generateLods](#generatelods) ·
    [貼圖編碼器](#貼圖編碼器)
- [範圍](#範圍)

---

## 是否需要 cook

不是必要步驟。`@web-world-engine/three` 會在 worker 中產生 LOD 鏈，形狀與
此處的產出一致（兩邊的預設參數對齊）。差別在成本：

| | cook 過的 | 執行期產生 |
| --- | ---: | --- |
| 產生成本 | 0 ms | 每個網格數十毫秒（於 worker 內） |
| 索引寬度 | 頂點數 < 65536 時為 16-bit | 一律 32-bit |
| 額外下載 | `.wwm` | meshoptimizer 約 44 kB |

執行期無從得知某個網格只需要 16-bit 索引，cook 時則可直接判定。

啟動時間或下載量成為問題時再將 cook 加入 build 流程。

## 命令列

```text
ww-cook <來源目錄> [選項]
```

來源目錄下的每個 `.glb` / `.gltf` 都會被烘焙。分離形式的 `.gltf` 會自動
帶上它引用的 `.bin` 與貼圖。

每個 glTF primitive 各自成為一個 mesh 資產：繪製單位本來就是 primitive，
不同材質必然是不同的 draw call。

### 選項

| 選項 | 預設 | 說明 |
| --- | --- | --- |
| `--out <目錄>` | `./public/cooked` | 輸出目錄 |
| `--verify` | 關閉 | 烘焙兩次並比對雜湊，驗證可重現性 |
| `--builtins` | 關閉 | 一併產生內建的程序化資產 |
| `-h`, `--help` | | 顯示用法 |

所有路徑相對於呼叫時的工作目錄。

`--builtins` 產生的是本專案的量測固定物（石頭、球、樹幹），一般專案不需要。

### 輸出

```text
public/cooked/
  assets.manifest.json    每個資產的區塊位置、LOD 誤差、包圍球
  mesh_*.wwm              頂點與各階索引
  texture_*.ktx2          BC 壓縮貼圖
```

`.wwm` 不是自描述的：各 LOD 的區塊位置記於 manifest，不重複記在檔頭。因此
`WW.load()` 需要 manifest 與資產 id 兩個參數。

本次不會產生的舊檔案會先被移除。殘留的舊檔會被繼續提供，最惡劣的形式是
cook 實際上失敗但瀏覽器載到舊檔，於是除錯的對象是一個已不存在的版本。

### 可重現性

同一批輸入必須得到同一個雜湊，否則兩台機器 cook 出的結果不同，快取永遠
是髒的。`--verify` 在同一個行程內烘焙兩次並比對 `contentHash`，任何隱藏的
狀態相依都會顯現。

檔案掃描順序經過排序：`readdirSync` 的順序在不同檔案系統上不保證一致，而
順序會影響 AssetId 的產生順序，進而影響 manifest 的雜湊。

## 烘焙的內容

### LOD 鏈

以 meshoptimizer 逐階簡化，每階記錄世界單位的幾何誤差。

**DEFAULT_LOD_OPTIONS**

| 參數 | 值 | 說明 |
| --- | --- | --- |
| `ratios` | `[0.5, 0.5, 0.4, 0.4, 0.4, 0.4]` | 每階相對前一階保留的三角形比例 |
| `maxRelativeError` | `0.2` | 相對誤差上限，超過即停止產生更粗的階 |

誤差上限 0.2 看似寬鬆，但選階是依螢幕空間誤差進行的：只有當該階的誤差
投影至螢幕不超過 `errorPixels`（預設 2 像素）時才會被選用，因此加入誤差
更大的階不會降低畫質 —— 它在近處不會被選中。

上限仍然存在，否則簡化器會將網格塌陷至失去形狀。那些階雖然合法，但佔用
檔案空間與載入時間，而極遠處應使用 impostor。

所有 LOD 共用同一份頂點，簡化只移除索引對部分頂點的參照。切階不需重新
上傳頂點。

### 切線

以 MikkTSpace 產生並寫入檔案。

法線貼圖的每個像素都是相對於某個切線基底的方向。烘焙貼圖的工具（Blender、
Substance、Marmoset）使用 MikkTSpace；runtime 若以其他方式推導切線，基底
與烘焙時不同，整張貼圖的光照都會偏移。該偏移不會使畫面損毀，只會使它看
起來略有落差，且極難歸因。

頂點佈局為 position(3) + normal(3) + uv(2) + tangent(4)，共 48 位元組。

### 貼圖

輸出 KTX2 容器內的 BC 壓縮資料，可直接上傳 GPU，不經解碼或 `ImageBitmap`。

| 用途 | 格式 |
| --- | --- |
| albedo（`compact`） | BC1，4 bpp |
| albedo（`high`） | BC7，8 bpp |
| 法線 | BC5，只存 XY，Z 於著色器重建 |
| AO + roughness | BC5，R = AO、G = roughness |

AO 與 roughness 沿用 glTF 的 ORM 通道順序，Three.js 的 `aoMap` 與
`roughnessMap` 各取 `.r` 與 `.g`，同一張貼圖可同時餵給兩者。metalness 未
納入 —— 這批材質都是非金屬，為一個全為 0 的通道支付頻寬沒有意義。

1024² 貼圖在 VRAM 的佔用由 RGBA8 的 5.3 MB 降至 BC7 的 1.4 MB。

### 碰撞網格

依 `collision` 選項產生簡化的三角網格，記於 `MeshEntry.collision`。關閉可
加快僅檢視外觀的迭代。

## 不支援的功能

以下內容會被丟棄。它們不會靜默消失：`manifest.warnings` 會逐項列出，CLI
也會印出，每一則都說明它在畫面上會表現成什麼。

| 丟棄的內容 | 畫面上的表現 |
| --- | --- |
| `JOINTS_0` / `WEIGHTS_0` | 角色停在 bind pose |
| skin（骨架） | 骨架階層消失 |
| morph target | 模型停在基礎形狀 |
| `COLOR_0` | 少掉一層著色 |
| `TEXCOORD_1` | lightmap 與 AO 貼圖取樣到錯的位置 |
| 動畫 | 匯入靜態幾何，動畫不進入 manifest |
| 非索引幾何 | 該 primitive 整個跳過 |
| `emissiveTexture` / `emissiveFactor` | 該部位不會發亮 |
| `alphaMode` | 一律視為不透明，鏤空與半透明變成實心 |
| `doubleSided` | 單面幾何從背面看會消失 |

「烘焙成功、零警告」而內容其實被丟棄，是這類工具最常見的失效形態。

骨骼動畫可改由 `WW.bakeVertexAnimation` 在執行期烘成貼圖。

## 程式介面

cooker 本身不接觸檔案系統：傳入的是位元組而非路徑，因此同樣能在瀏覽器或
測試中執行。掃描目錄是 CLI 的責任。

### cookAll

```ts
import { cookAll, COOKER_VERSION } from '@web-world-engine/cook';

const { manifest, files } = await cookAll({ sourceFiles });
```

**CookOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `sourceFiles` | `Array<{ name, bytes, resources? }>` | `[]` | 要烘焙的 glTF 位元組 |
| `lod` | `LodOptions` | `DEFAULT_LOD_OPTIONS` | LOD 鏈設定 |
| `collision` | `boolean` | 開啟 | 產生碰撞網格 |
| `builtins` | `boolean` | `false` | 一併產生內建的程序化資產 |
| `materials` | `MaterialEntry[]` | 內建 | 材質定義 |
| `textureSize` | `number` | `256` | 程序化貼圖邊長，須為 4 的倍數 |
| `textureQuality` | `'compact' \| 'high'` | `'compact'` | albedo 的壓縮檔次 |

`resources` 是 `.gltf` 的外部資源對照（URI → 位元組），`.glb` 不需要。分離
形式是真實匯出流程的常態，Sponza 與 Bistro 也只有 `.gltf` 版本。

回傳 `{ manifest, files }`，`files` 是檔名到位元組的 `Map`，寫檔由呼叫端
負責。

### importGltf

```ts
const { primitives, warnings } = await importGltf(bytes, name, resources);
```

讀出檔案中所有 primitive，並回報被丟棄的內容。每則 `ImportWarning` 含
`source`（哪一個 primitive）、`dropped`（丟了什麼）與 `effect`（畫面上的
表現）。

### generateLods

```ts
const lods = await generateLods(mesh, DEFAULT_LOD_OPTIONS);
```

回傳 `LodResult[]`，每項含 `mesh` 與世界單位的 `error`。誤差以世界單位
回報而非相對值：選階需要計算誤差投影至螢幕的像素數，相對值無法完成該計算。

同一模組另提供 `weld`、`generateTangents`、`recomputeNormals`、
`computeBounds`、`generateCollision` 與 `optimizeLodChain`；`validateMesh`
與 `cookMesh` 來自 pipeline，前者回傳警告清單而非拋出例外 —— 退化三角形
可以修，索引越界不行，呼叫端需要知道差別。

### 貼圖編碼器

```ts
import { encodeBc1, encodeBc5, encodeBc7, decodeBc1, decodeBc7 } from '@web-world-engine/cook/texture';
```

獨立的進入點，僅含純計算的編碼器與解碼器，不引用 `node:fs`，因此可打包
進瀏覽器。

這條界線不是為了整潔：驗證編碼器的唯一可信方式是讓硬體解碼器讀它的輸出，
而那必須在瀏覽器裡執行。

另提供 `generateMipChain`、`renormalizeNormals` 與 `blocksFor`。

## 範圍

貼圖只產生 BC 系列，對應桌機。行動裝置的 ETC2 與 ASTC 不在範圍內：沒有
桌機能解碼它們，寫出來的編碼器只能用自己的解碼器驗證。

---

[變更紀錄](https://github.com/th1230/WebWorldEngine/blob/main/CHANGELOG.md) ·
[原始碼](https://github.com/th1230/WebWorldEngine/tree/main/packages/cook) ·
[問題回報](https://github.com/th1230/WebWorldEngine/issues)

MIT
