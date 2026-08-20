# @web-world-engine/three

[![npm](https://img.shields.io/npm/v/@web-world-engine/three.svg)](https://www.npmjs.com/package/@web-world-engine/three)
[![授權](https://img.shields.io/npm/l/@web-world-engine/three.svg)](https://github.com/th1230/WebWorldEngine/blob/main/LICENSE)
[![CI](https://github.com/th1230/WebWorldEngine/actions/workflows/ci.yml/badge.svg)](https://github.com/th1230/WebWorldEngine/actions/workflows/ci.yml)

Three.js 的大世界工具集：螢幕誤差 LOD、空間分割剔除、內容串流，以及陰影、
間接光、反射、地形與水的實作。

```bash
npm i @web-world-engine/three
```

```js
import * as WW from '@web-world-engine/three';

const rocks = new WW.InstancedMesh(geometry, material, 10000);
for (let i = 0; i < 10000; i++) rocks.setMatrixAt(i, matrix);
scene.add(rocks);
```

`WW.InstancedMesh` 是 `THREE.Object3D` 的子類，加入場景後即開始運作，不需要
初始化或每幀更新。它會依螢幕誤差選擇 LOD 階，並以空間分割做視錐剔除。

## 相容性

| | |
| --- | --- |
| Three.js | `>=0.185.0 <0.186.0`（peer dependency） |
| 模組格式 | ESM。CommonJS 需使用動態 `import()` |
| 執行環境 | 桌機瀏覽器，WebGL2 或 WebGPU |
| Node | `>=22.12`（建置工具鏈；執行期在瀏覽器） |
| 型別 | 內建 `.d.ts` |

Three.js 的版本範圍限定於單一 minor：本套件使用 `THREE.BatchedMesh` 的內部
欄位，該部分沒有公開的等效介面。若結構變動，`WW.InstancedMesh` 會在建構時
拋出例外並列出缺少的欄位。

## 目錄

- [核心概念](#核心概念)
  - [world 與每幀的邊界](#world-與每幀的邊界)
  - [螢幕空間效果的共通介面](#螢幕空間效果的共通介面)
  - [WebGL 與 WebGPU](#webgl-與-webgpu)
- [幾何與實例](#幾何與實例)
  - [InstancedMesh](#instancedmesh) ·
    [MultiMesh](#multimesh) ·
    [ImpostorBatch](#impostorbatch) ·
    [AnimatedInstancedMesh](#animatedinstancedmesh) ·
    [scatter](#scatter)
- [資產載入](#資產載入)
  - [load](#load) · [loadMaterial](#loadmaterial) · [loadTexture](#loadtexture)
- [大世界](#大世界)
  - [worldFor().stream](#worldforstream) · [OriginRebase](#originrebase) ·
    [VirtualTexture](#virtualtexture)
- [陰影](#陰影)
  - [applyShadows](#applyshadows) · [VirtualShadowMap](#virtualshadowmap) ·
    [ContactShadows](#contactshadows) · [DistanceFieldShadows](#distancefieldshadows)
- [間接光與反射](#間接光與反射)
  - [IrradianceVolume](#irradiancevolume) · [ScreenSpaceGI](#screenspacegi) ·
    [ReflectionProbes](#reflectionprobes) · [TracedReflections](#tracedreflections) ·
    [GlobalDistanceField](#globaldistancefield)
- [大氣與霧](#大氣與霧)
  - [SkyAtmosphere](#skyatmosphere) · [VolumetricFog](#volumetricfog)
- [地形、水、物理](#地形水物理)
  - [buildTerrain](#buildterrain) · [buildHeightfield](#buildheightfield) ·
    [Water](#water) · [WaterSurface](#watersurface) ·
    [computeBuoyancy](#computebuoyancy) · [PhysicsScheduler](#physicsscheduler)
- [診斷](#診斷)
  - [stats](#stats) · [debugMode](#debugmode) · [工具函式](#工具函式)
- [品質契約](#品質契約)

每個功能在 [`apps/example`](https://github.com/th1230/WebWorldEngine/tree/main/apps/example/src)
都有一個可執行的場景，可作為完整範例。

---

## 核心概念

### world 與每幀的邊界

`WW.worldFor(scene)` 取得該場景的共用狀態。多數功能不需要它；需要它的是
跨物件共用的資源：內容串流、統計，以及螢幕空間效果共用的深度法線圖。

該深度法線圖每幀只需繪製一次。由於套件掛在 `onBeforeRender` 上，無法自行
判斷幀的邊界，因此需要每幀宣告一次：

```js
const world = WW.worldFor(scene);

function frame() {
  world.beginFrame();

  const shadow = contact.render(renderer, scene, camera, { lightDirection });
  const fog = volumetric.render(renderer, scene, camera, { lightDirection, lightColor });

  renderer.render(scene, camera);
  composite(shadow, fog);
  requestAnimationFrame(frame);
}
```

各效果自行向 world 取得該圖，第一個要求的觸發繪製。省略 `beginFrame()` 不影響
畫面正確性，該圖會改為每個效果各繪製一次。

**`world.setDepthNormals(options)`** 調整該圖的解析度。

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `scale` | `number` | `0.5` | 相對於畫布的解析度倍率 |

### 螢幕空間效果的共通介面

`ContactShadows`、`DistanceFieldShadows`、`VolumetricFog`、`TracedReflections`、
`ScreenSpaceGI` 與 `VirtualShadowMap` 共用同一個簽名：

```js
effect.render(renderer, scene, camera, frame);   // → Texture | null
```

| 參數 | 說明 |
| --- | --- |
| `renderer` | `WebGLRenderer` 或 `WebGPURenderer` |
| `scene`、`camera` | 用於取得共用資源與投影矩陣 |
| `frame` | 該幀會變動的參數，各效果不同 |

回傳貼圖而非直接寫入畫面，合成方式由呼叫端決定。WebGPU 上的 node 材質為
非同步建立，尚未就緒時回傳 `null`。

### WebGL 與 WebGPU

同一份程式碼在兩個 renderer 上執行。凡是需要修改材質的功能（間接光、頂點
動畫、換階淡入、虛擬貼圖）都有兩份實作：WebGL 透過 `onBeforeCompile` 注入
GLSL，WebGPU 設定 node。

WebGPU 上這些功能需要 node 材質。`WebGPURenderer` 不呼叫 `onBeforeCompile`，
且呼叫端持有的 `MeshStandardMaterial` 並非 node 材質（轉換由 renderer 內部
進行）：

```js
import { MeshStandardNodeMaterial } from 'three/webgpu';

const material = await WW.loadMaterial(url, id, { MaterialClass: MeshStandardNodeMaterial });
```

`three/tsl` 與 `three/webgpu` 採動態載入，僅使用 WebGL 的專案不會下載這部分。
node 材質建立完成前，相關介面回傳 `null`：

```js
await WW.irradianceNodeReady(volume);
await WW.skyNodeReady(sky);
```

---

## 幾何與實例

### InstancedMesh

大量相同幾何的實例繪製，具備逐實例的 LOD 選階與空間分割剔除。取代
`THREE.InstancedMesh`。

```js
new WW.InstancedMesh(source, material, count, options?)
```

`source` 接受三種形式：

```js
new WW.InstancedMesh(geometry, material, n);                     // LOD 鏈於 worker 內產生
new WW.InstancedMesh({ lods, errors }, material, n);             // 自備 LOD 鏈
new WW.InstancedMesh(await WW.load(manifest, id), material, n);  // cook 過的資產
```

**InstancedMeshOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `errorPixels` | `number` | `2` | 選階時允許的螢幕誤差上限，單位為像素 |
| `instancesPerCell` | `number` | `64` | 空間分割每格的目標實例數 |
| `lodFadeBand` | `number` | `0` | 換階交叉淡入的距離比例，`0` 為關閉 |
| `occlusion` | `boolean` | `false` | 啟用遮蔽剔除 |
| `dynamic` | `boolean` | 自動 | 宣告實例矩陣會頻繁變動 |
| `autoLod` | `boolean` | `true` | 未提供 LOD 鏈時自動產生 |
| `hlod` | `boolean` | `true` | 啟用遠景合併 |
| `hlodBudgetMB` | `number` | `64` | 遠景合併的記憶體上限 |
| `shadowErrorPixels` | `number` | `errorPixels × 3` | 陰影 pass 的螢幕誤差上限 |
| `shadowCulling` | `boolean` | `true` | 陰影 pass 執行自己的剔除 |

與 `THREE.InstancedMesh` 的行為差異：

| | |
| --- | --- |
| `.geometry` | 回傳內部合併後的幾何。傳入的原始幾何在 `.sourceGeometry` |
| `.isInstancedMesh` | 不存在。本類別繼承 `THREE.BatchedMesh`，具有 `.isBatchedMesh` |
| `.count` | 語意相同，僅繪製前 N 個實例 |
| `.instanceMatrix` | 存在，與內部儲存共用記憶體，`needsUpdate` 有效 |

#### 遠景合併（HLOD）

當一個空間格內的實例全部落在最粗階時，改送一份預先合併的幾何，減少繪製
呼叫。預設啟用，以 `{ hlod: false }` 關閉。

合併幾何存放於固定大小的槽位池，超出 `hlodBudgetMB` 時不啟用並輸出說明。
烘焙分幀進行，每幀上限 2 ms；尚未完成的格子維持逐實例送出。

六萬個實例、完整 PBR 材質的場景，同一份內容開關 `hlod`：

| | 啟用 | 關閉 |
| --- | ---: | ---: |
| 繪製次數 | 1,830 | 27,418 |
| GPU | 2.06 ms | 6.59 ms |
| 幀 p95 | 6.40 ms | 16.20 ms |

僅合併已在最粗階的實例，細階的分佈兩邊完全相同，因此不影響畫質。

#### 換階淡入

`lodFadeBand` 設為大於 0 時，越過換階門檻後的該比例距離內同時繪製兩階，
以互補的抖動遮罩各自丟棄一半像素。

預設關閉：散開的兩萬個實例在相機推進時，單幀最多 75 個實例換階（0.4%），
而淡入需為其多繪製一次。密集排列的內容換階數較高（同樣數量下為 692 個）。

需要材質支援注入（WebGL 為 `onBeforeCompile`，WebGPU 為 `maskNode`）。無法
接上時輸出提示。

#### 遮蔽剔除

`{ occlusion: true }` 啟用後，移除確定被遮蔽的實例。適用於少數大型遮蔽物的
場景（牆、山、建築）。

密集散佈的小物件上剔除率極低：遮蔽物僅能使用內接盒、被測物需使用外接球，
兩層保守估計相乘後幾乎無法通過。本專案的代表性內容上剔除 0 個，而每幀額外
消耗 1–4 ms CPU。因此預設關閉；啟用後若連續 120 幀幾乎無剔除會輸出警告。

以下兩個數值可判斷是否值得啟用：

```js
rocks.stats.occluded;            // 該幀剔除的實例數
rocks.stats.cpuParts.occlusion;  // 為此消耗的 CPU 時間
```

### MultiMesh

將單一大型幾何切成多個區塊，各自選階與剔除。適用於掃描資料、整片地形或
單一大型 GLB —— 這類幾何若不切開，選階會被最近的區域決定。

```js
const pieces = await WW.splitWithLods(geometry, options?);
scene.add(new WW.MultiMesh(pieces, material, options?));
```

**SplitOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `chunks` | `number` | `64` | 目標區塊數 |

切出的區塊一律鎖定邊界簡化，否則相鄰區塊的共用邊會被化簡成不同形狀而產生
裂縫。此行為不可關閉。

僅需切塊而不需 LOD 時使用 `WW.splitGeometry(geometry, options?)`，回傳的
區塊同樣支援逐塊剔除。

288 萬個三角形的地面，相機貼近地面觀察遠方：

| | GPU | 送出的三角形 |
| --- | ---: | ---: |
| 未切分 | 6.665 ms | 2,880,546 |
| 切成 256 塊 | 1.934 ms | 84,866 |

畫面差異 0.04%。

### ImpostorBatch

以面向相機的看板取代遠處的複雜物件。烘焙時繞物件取多個方向的影像，執行期
依視角選擇對應的影像。

```js
const baked = WW.bakeImpostor(renderer, object, options?);
const forest = new WW.ImpostorBatch(baked, count);
forest.setMatrixAt(i, matrix);
```

**ImpostorBakeOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `views` | `number` | `16` | 環繞物件取樣的方向數 |
| `size` | `number` | `128` | 每個方向的影像邊長 |

看板是近似，需要決定切換距離。兩萬棵樹的量測：

| 相機距離 | 省下 | 畫面差異 |
| ---: | ---: | ---: |
| 300 | 60.0% | 31.20% |
| 700 | 65.0% | 7.94% |
| 1,500 | 90.4% | 0.01% |
| 3,000 | 96.1% | 0.00% |

省下的比例以未使用 LOD 的幾何為基準。與完整 LOD 鏈的最粗階相比約為四倍。

### AnimatedInstancedMesh

將骨骼動畫烘成貼圖，使同一動畫的多個實例共用一次繪製。

```js
const baked = WW.bakeVertexAnimation(mesh, clip, options?);
const crowd = new WW.AnimatedInstancedMesh(baked, material, count);
```

**BakeOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `frames` | `number` | `32` | 取樣的動畫幀數 |

WebGL 與 WebGPU 皆有實作。

### scatter

在指定區域內產生實例矩陣，可對齊地形高度。

```js
const matrices = WW.scatter({ count: 20000, area, align: 'terrain', height });
```

---

## 資產載入

載入由 [`@web-world-engine/cook`](https://www.npmjs.com/package/@web-world-engine/cook)
產生的資產。cook 是選配的：僅提供 `BufferGeometry` 時 LOD 鏈會在 worker 內
產生，形狀與 cook 的輸出一致。

### load

```js
const chain = await WW.load(manifestUrl, assetId);   // → LodChain
```

回傳的 LOD 鏈可直接傳給 `WW.InstancedMesh`。

### loadMaterial

```js
const material = await WW.loadMaterial(manifestUrl, assetId, options?);
```

回傳 `THREE.MeshStandardMaterial`，其屬性可照常修改。

**LoadMaterialOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `MaterialClass` | `typeof MeshStandardMaterial` | `MeshStandardMaterial` | WebGPU 上需傳入 `MeshStandardNodeMaterial` |

`.ktx2` 的 BC 資料直接上傳 GPU，不經解碼或 `ImageBitmap`。1024² 貼圖在 VRAM
的佔用由 RGBA8 的 5.3 MB 降至 BC7 的 1.4 MB。

### loadTexture

```js
const texture = await WW.loadTexture(manifestUrl, textureId);
```

載入單張貼圖。釋放材質使用 `WW.releaseMaterial(material)`，內部有參考計數。
`WW.clearAssetCache()` 清除 manifest 快取。

---

## 大世界

### worldFor().stream

以格為單位串流內容。`load` 回呼只需回答單一格的內容，載入與卸載時機、
優先序與每幀預算由套件處理。

```js
WW.worldFor(scene).stream({
  cellSize: 120,
  radius: 600,
  load(cx, cz, place) {
    for (let i = 0; i < 400; i++) place(rocks, matrix.compose(/* … */));
  },
});
```

**StreamOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `cellSize` | `number` | 必填 | 單格的世界邊長 |
| `radius` | `number` | 必填 | 以相機為中心的載入半徑 |
| `load` | `(cx, cz, place) => void` | 必填 | 產生該格內容 |
| `unloadRadius` | `number` | `radius × 1.25` | 卸載半徑，需大於載入半徑以避免邊界抖動 |
| `maxConcurrentLoads` | `number` | `16` | 同時進行的載入數 |
| `frameBudgetMs` | `number` | 無限制 | 每幀用於載入的時間上限 |
| `onCellChanged` | `(cell) => void` | — | 格內容變動時的通知，供烘焙資料失效使用 |

`place(mesh, matrix)` 會立即複製矩陣，因此可重複使用同一個 `Matrix4`。

回傳 `WorldStream`，與 `world.streaming` 為同一個物件。`WorldStream.stats`
提供常駐、載入中、待處理與失敗的數量。未呼叫 `stream()` 時 `world.streaming`
為 `null`，內容全部常駐。

### OriginRebase

在相機遠離原點時將世界平移回原點附近，避免浮點精度不足。

```js
const rebase = new WW.OriginRebase({ onRebase: (offset) => sun.position.add(offset) });
rebase.add(rocks);
rebase.update(camera);   // 每幀呼叫
```

**OriginRebaseOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `threshold` | `number` | `4096` | 相機距原點超過此值時觸發平移 |
| `onRebase` | `(offset: Vector3) => void` | — | 平移發生時的通知，用於同步未註冊的物件 |

`Float32Array` 在距原點十萬單位處的間距為 0.008，公分級的細節會開始塌陷，
表現為畫面抖動。`rebase.origin` 保留真實世界座標，供存檔與連線使用。

### VirtualTexture

貼圖總量超過 VRAM 時，將貼圖切成頁，僅將需要的頁載入圖集。

```js
const vt = new WW.VirtualTexture({
  pageSize: 128,
  pagesPerSide: 64,
  atlasPages: 8,
  page(level, px, py, size) {
    return loadPagePixels(level, px, py, size);
  },
});

vt.apply(material);
vt.request(level, px, py);
vt.update(8);
```

**VirtualTextureOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `pagesPerSide` | `number` | 必填 | 一邊的頁數，必須是 2 的次方 |
| `page` | `(level, px, py, size) => Uint8Array \| Promise` | 必填 | 產生單頁的像素 |
| `pageSize` | `number` | `128` | 單頁邊長，單位為 texel |
| `atlasPages` | `number` | `16` | 圖集一邊的頁數，`atlasPages²` 為同時可駐留的頁數 |
| `border` | `number` | `4` | 每頁四周的邊界像素，供雙線性取樣使用 |

虛擬解析度為 `pageSize × pagesPerSide`。`update(budgetMs)` 每幀呼叫，將已
要求的頁搬入圖集。

省略 `border` 會使頁與頁之間在特定縮放比例下出現接縫。

---

## 陰影

### applyShadows

將 Three.js 的 CSM addon 接上場景中的所有材質。

```js
const csm = new CSM({ camera, parent: scene, cascades: 4 });
WW.applyShadows(csm, scene);
```

CSM 的 `setupMaterial` 需逐材質呼叫，遺漏的材質不會顯示陰影；且它直接指派
`onBeforeCompile`，會覆蓋其他注入。本函式處理這兩點，呼叫順序不影響結果。

### VirtualShadowMap

分頁的陰影圖，提供遠高於硬體上限的等效解析度，僅配置可見範圍的頁。

```js
const vsm = new WW.VirtualShadowMap({ pagesPerSide: 512, pageSize: 64, atlasPages: 32 });
vsm.setLight(lightDirection, worldCentre);

function frame() {
  world.beginFrame();

  const { u: u0, v: v0 } = vsm.worldToUv(nearCorner);
  const { u: u1, v: v1 } = vsm.worldToUv(farCorner);
  vsm.requestRegion(u0, v0, u1, v1, 0);
  vsm.update(renderer, scene);

  const mask = vsm.render(renderer, scene, camera);   // 1 = 受光、0 = 陰影
}
```

**VirtualShadowMapOptions**（繼承 `VirtualTextureLayout`）

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `pagesPerSide` | `number` | 必填 | 一邊的頁數，必須是 2 的次方 |
| `pageSize` | `number` | `128` | 單頁邊長 |
| `atlasPages` | `number` | `16` | 圖集一邊的頁數，決定實際記憶體用量 |
| `extent` | `number` | `400` | 光源覆蓋的世界範圍 |
| `depth` | `number` | `800` | 光源視錐的深度範圍 |
| `budget` | `number` | `8` | 每幀繪製的頁數上限 |

`update` 處理光源側（重繪需要的頁），`render` 處理畫面側（判斷像素是否在
陰影中），兩者皆需每幀呼叫。

頁的繪製自行執行視錐剔除與選階：陰影圖上單一 texel 對應的世界尺度與主畫面
不同，沿用主畫面的選階會在遠處產生過細的幾何。

### ContactShadows

在螢幕空間沿光線行進，補上 shadow map 因深度精度而無法表現的貼合處遮蔽。

```js
const contact = new WW.ContactShadows(options?);
const mask = contact.render(renderer, scene, camera, { lightDirection });
```

**ContactShadowsOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `distance` | `number` | `0.5` | 射線行進的最大世界距離 |
| `steps` | `number` | `12` | 每條射線的取樣步數 |
| `thickness` | `number` | `0.3` | 遮蔽物的深度上限 |
| `strength` | `number` | `0.75` | 遮蔽強度 |

`frame` 需提供 `lightDirection`（世界空間，由光源指向場景）。

`thickness` 是必要的：螢幕空間無法區分深度差距，省略後浮空物件會在地面
投下不存在的陰影。

### DistanceFieldShadows

沿距離場追蹤陰影，涵蓋畫面外的遮蔽物。

```js
const shadows = new WW.DistanceFieldShadows(options?);
const mask = shadows.render(renderer, scene, camera, { field, lightDirection });
```

**DistanceFieldShadowsOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `steps` | `number` | `48` | 球體追蹤的步數上限（自適應，非實際步數） |
| `softness` | `number` | `8` | 陰影邊緣的柔和度，即追蹤錐體的角度 |
| `strength` | `number` | `1` | 陰影強度 |
| `range` | `number` | 場的一半 | 追蹤距離，超過距離場範圍即無資料 |

`frame` 需提供 `field`（[`GlobalDistanceField`](#globaldistancefield)）與
`lightDirection`。

---

## 間接光與反射

### IrradianceVolume

烘焙一格輻照度探針，每顆儲存 SH L1，著色時為一次三維查表。

```js
const volume = new WW.IrradianceVolume({ min, size, resolution: [16, 4, 16] });
await WW.bakeIrradiance(renderer, scene, volume);
WW.applyIrradiance(volume, scene);
```

**IrradianceVolumeOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `min` | `Vector3` | 必填 | 體積的最小角 |
| `size` | `Vector3` | 必填 | 體積的邊長 |
| `resolution` | `[number, number, number]` | 必填 | 三軸的探針數 |
| `intensity` | `number` | `1` | 間接光強度 |

**IrradianceBakeOptions**（`bakeIrradiance` 的第四個參數）

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `budgetMs` | `number` | `8` | 單次呼叫的時間上限 |
| `faceSize` | `number` | `16` | cubemap 每面的邊長 |
| `reflection` | `ReflectionProbes` | — | 同時產生反射探針 |
| `near` / `far` | `number` | `0.1` / `1000` | 烘焙相機的裁切面 |

`bakeIrradiance` 分幀進行，需重複呼叫直到 `volume.baked === volume.probeCount`。

動態物件的反彈光以標記過期處理：

```js
volume.invalidateAround(car.position, 14);
```

過期探針優先重烘，單顆成本 2.7 ms。間接光會延遲數幀跟上。

### ScreenSpaceGI

自畫面既有像素收集一次反彈的間接光，尺度為像素級。與 `IrradianceVolume`
互補：探針涵蓋大範圍與畫面外，本效果涵蓋小於探針格距的結構。

```js
const ssgi = new WW.ScreenSpaceGI(options?);
const indirect = ssgi.render(renderer, scene, camera, { color: sceneColorTexture });
```

**ScreenSpaceGiOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `radius` | `number` | `4` | 收集的世界半徑 |
| `intensity` | `number` | `1` | 強度 |
| `scale` | `number` | `0.5` | 收集圖相對畫布的解析度倍率 |

`frame` 需提供 `color`（已繪製完成的畫面貼圖）。

方法本身的限制：僅涵蓋畫面內的像素、單次反彈、有雜訊、被遮蔽處無資料。

### ReflectionProbes

與輻照度探針共用同一次拍攝，額外產生反射用的八面體投影。

```js
const reflection = new WW.ReflectionProbes(volume, options?);
await WW.bakeIrradiance(renderer, scene, volume, { reflection });
```

**ReflectionProbesOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `tileSize` | `number` | `16` | 圖集中單顆探針的邊長 |

烘焙輻照度時已將 cubemap 六個面讀回 CPU，而讀回是整個流程中最昂貴的部分
（單顆 2.7 ms，其中繪製佔 0.3 ms）。共用同一次拍攝的代價是兩者使用同一組
探針位置與同一份過期清單。

### TracedReflections

三層依序遞補的反射：螢幕空間、距離場、反射探針。

```js
const reflections = new WW.TracedReflections(options?);
const result = reflections.render(renderer, scene, camera, {
  color: sceneColorTexture,
  field,
  irradiance,
  probes,
});
```

**TracedReflectionsOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `screenSteps` | `number` | `24` | 螢幕空間追蹤的步數 |
| `screenStep` | `number` | `0.4` | 單步的世界距離 |
| `thickness` | `number` | `1` | 命中判定的深度容差 |
| `fieldSteps` | `number` | `48` | 距離場追蹤的步數 |
| `range` | `number` | 場的一半 | 距離場追蹤的距離上限 |
| `roughness` | `number` | `0.15` | 表面粗糙度，`1` 時螢幕空間層權重為零 |
| `sky` | `Color` | `#2a3a55` | 完全未命中時的顏色 |

`frame` 的 `color` 為必填，`field`、`irradiance`、`probes` 為選配。僅提供
`color` 時為純螢幕空間反射。

三層的涵蓋範圍：螢幕空間最精確但僅限畫面內；距離場涵蓋畫面外但無顏色資訊；
探針提供畫面外的顏色但為低頻。

### GlobalDistanceField

以相機為中心的三維距離場，合成場上各物件的距離場。距離場陰影、追蹤反射與
體積霧共用同一份。

```js
const field = new WW.GlobalDistanceField(options?);
field.add({ volume: new WW.DistanceFieldVolume(geometry), matrixWorld: mesh.matrixWorld });
field.update(cameraPosition);   // 每幀呼叫
```

**GlobalDistanceFieldOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `resolution` | `number` | `32` | 場的三軸格數 |
| `extent` | `number` | `200` | 場涵蓋的世界邊長 |
| `budget` | `number` | `4096` | 每幀重算的格數上限 |

`update` 分幀補格。相機大幅移動時整份場需要重算，分幀進行期間場為舊資料，
遮蔽會延遲跟上。

`field.pendingCells` 為尚未重算的格數。

三種間接光的涵蓋範圍互補：

| | 涵蓋畫面外 | 可查詢角落遮蔽 |
| --- | --- | --- |
| `ScreenSpaceGI` | ❌ | ✅ |
| `IrradianceVolume` | ✅ | ❌ |
| `GlobalDistanceField` | ✅ | ✅ |

---

## 大氣與霧

### SkyAtmosphere

大氣散射烘成 cubemap，可直接作為 `scene.background`。

```js
const sky = new WW.SkyAtmosphere(options?);
scene.background = sky.texture;

sky.update(renderer, sunDirection);   // 每幀呼叫
```

**SkyAtmosphereOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `resolution` | `number` | `64` | cubemap 每面的邊長 |
| `threshold` | `number` | `0.01` | 太陽方向的變化門檻，超過才重烘 |
| `intensity` | `number` | `22` | 亮度倍率 |
| `mieDirectional` | `number` | `0.76` | Mie 散射的方向性 |

`update` 依 `threshold` 判斷是否重烘，回傳是否實際執行。

### VolumetricFog

沿視線積分散射，可依距離場產生遮蔽。

```js
const fog = new WW.VolumetricFog(options?);
const scattered = fog.render(renderer, scene, camera, { lightDirection, lightColor, field });
```

**VolumetricFogOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `density` | `number` | `0.02` | 消光係數 |
| `steps` | `number` | `32` | 沿視線的積分步數 |
| `range` | `number` | `400` | 積分的最大距離 |
| `color` | `Color` | `#b8c6d8` | 霧的顏色 |
| `anisotropy` | `number` | `0.6` | 相位函數的方向性，決定迎光與背光的亮度差 |
| `shadowSteps` | `number` | `24` | 每個取樣點的遮蔽追蹤步數 |

`frame` 需提供 `lightDirection` 與 `lightColor`；`field` 為選配，提供時
遮蔽物後方不會產生光柱。

積分起點帶抖動。固定起點會在畫面上產生規則條帶。

---

## 地形、水、物理

### buildTerrain

由高度函式產生分塊的地形幾何，每塊帶 LOD 鏈，可直接交給 `MultiMesh`。

```js
const terrain = WW.buildTerrain({ size: 4000, tiles: 8, segments: 64, height });
```

**TerrainOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `size` | `number` | 必填 | 整片地形的世界邊長 |
| `tiles` | `number` | 必填 | 一邊的分塊數 |
| `segments` | `number` | 必填 | 單塊的網格細分數，必須是 2 的冪 |
| `height` | `(x, z) => number` | 必填 | 高度函式 |
| `levels` | `number` | 自動 | LOD 階數 |

回傳 `{ chains, centers, triangles, skirtDepth }`。`chains` 交給 `MultiMesh`，
`centers` 用於設定每塊的矩陣。

### buildHeightfield

由同一個高度函式產生碰撞用的高度場。

```js
const field = WW.buildHeightfield({ size: 4000, samples: 129, height });
```

**TerrainHeightfieldOptions**

| 參數 | 型別 | 說明 |
| --- | --- | --- |
| `size` | `number` | 世界邊長，須與 `buildTerrain` 的 `size` 相同 |
| `samples` | `number` | 一邊的取樣數 |
| `height` | `(x, z) => number` | 高度函式 |

回傳 `{ rows, columns, heights, scale }`，格式可直接交給 Rapier 的
heightfield collider。繪製與碰撞取自同一個高度函式，避免兩者不一致。

### Water

波形定義，供頂點著色器、CPU 查詢與浮力共用。

```js
const water = new WW.Water({ level: 0 });

water.displacementGLSL();   // 頂點著色器用的位移程式碼
water.heightAt(x, z, t);    // CPU 側的同一個水面
```

**WaterOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `level` | `number` | `0` | 靜止水位 |
| `waves` | `readonly WaterWave[]` | `DEFAULT_WAVES` | 波的組成 |

### WaterSurface

水面的外觀：吸收、折射與泡沫。

```js
const surface = new WW.WaterSurface({ water });
surface.setTime(t);
surface.capture(renderer, scene, camera, waterMesh);
waterMesh.material = surface.materialFor(renderer);
```

**WaterSurfaceOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `water` | `Water` | 必填 | 波形定義 |
| `absorption` | `[number, number, number]` | `[0.35, 0.045, 0.02]` | 三色通道的吸收係數，決定深度造成的色偏 |
| `scatter` | `Color` | `#0a2b33` | 水體的散射色 |
| `refraction` | `number` | `0.05` | 折射位移的強度 |
| `foamDepth` | `number` | `1.5` | 岸邊泡沫的水深範圍 |
| `crestFoam` | `number` | `0` | 浪尖泡沫的強度 |
| `sunDirection` | `Vector3` | `(0.4, …)` | 高光的光源方向 |
| `sunColor` | `Color` | `#ffffff` | 高光顏色 |
| `sky` | `Color` | `#86a8c8` | 反射的天空色 |
| `reflectivity` | `number` | `1` | 反射強度 |

`capture` 取得折射所需的畫面，需在繪製水面之前呼叫。`setParams(changes)`
在執行期調整上述參數，會同時更新兩個後端。

### computeBuoyancy

依水面高度計算浮力。

```js
const forces = WW.computeBuoyancy(water, bodies, t);
```

回傳每個 body 的力，施加由呼叫端負責。Rapier 的 `addForce` 會持續累加，
每幀須先呼叫 `resetForces()`。

### PhysicsScheduler

決定哪些剛體進入求解器。求解本身交由 Rapier 或其他求解器處理，本層僅以 id
追蹤，不依賴具體型別。

```js
const scheduler = new WW.PhysicsScheduler({
  activeRadius: 200,
  maxActive: 120,
  onActivate,
  onDeactivate,
});
```

**PhysicsSchedulerOptions**

| 參數 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `activeRadius` | `number` | 必填 | 進入求解器的半徑 |
| `onActivate` | `(id: number) => void` | 必填 | 剛體進入時的回呼 |
| `onDeactivate` | `(id: number) => void` | 必填 | 剛體退出時的回呼 |
| `sleepRadius` | `number` | `activeRadius × 1.25` | 退出半徑，大於進入半徑以避免邊界抖動 |
| `maxActive` | `number` | `Infinity` | 同時求解的剛體數上限 |

---

## 診斷

### stats

```js
const world = WW.worldFor(scene);

world.stats;              // { objects, instances, visible, tested, cells, … }
world.streaming?.stats;   // { resident, loading, pending, failedLoads, … }
rocks.stats;              // { visible, tested, levels, cpuMs, cpuParts, spatial }
```

套件不依裝置效能自動降級。品質取捨屬於應用層的決策。

### debugMode

多段式的效果可將中間值輸出至畫面：

```js
contact.debugMode = 1;
reflections.debugMode = 3;   // 0 正常、1 體積座標、2 反射方向、3 第 0 顆探針…
vsm.debugMode = 1;
surface.debugMode = 10;      // 10 為折射偏移
```

`0` 一律為正常繪製。其餘號碼由各效果定義，兩個後端使用相同編號。

### 工具函式

| | |
| --- | --- |
| `readPixelsAsync(renderer, target, x, y, w, h, alloc)` | 非同步讀回 GPU 像素，WebGL 走 PBO |
| `world.depthNormals(renderer, camera)` | 共用的 `SceneDepthNormals`，提供 `depthTexture` / `normalTexture` |
| `translateObject(object, offset)` | 平移物件，含內部的實例資料 |
| `clearAssetCache()` / `disposeBakeCache(renderer)` | 釋放 manifest 與烘焙暫存 |
| `DEFAULT_WAVES` | `Water` 的預設波形 |
| `PageTable` | 分頁資源的頁表，轉出自 `@web-world-engine/format` |

自行組裝 LOD 鏈時可用：

```js
WW.sphericalLodErrors(geometries);              // 由細到粗的幾何 → 每階誤差
WW.pixelsPerUnit(viewportHeight, fovYRadians);  // 一世界單位的螢幕像素數
WW.selectLevel(errors, perMetre, errorPixels);  // 該距離對應的階
WW.isLodChain(source);                          // 判別傳入的是幾何或 LOD 鏈
```

自訂材質若需支援換階淡入，另有 `LOD_FADE_VERTEX_GLSL`、
`LOD_FADE_FRAGMENT_GLSL` 與 `LOD_FADE_CAPACITY`。

---

## 品質契約

LOD 選階的保證：被選中的階，其幾何誤差投影至螢幕的量不超過 `errorPixels`
（預設 2 像素）。這是位置誤差的上限，不涵蓋法線與著色。

`errorPixels` 是畫質與效能的取捨參數。

行動裝置不在支援範圍內：貼圖僅產生 BC 系列，ETC2 / ASTC 沒有桌機可解碼，
編碼器無法以獨立的解碼器驗證。

---

[變更紀錄](https://github.com/th1230/WebWorldEngine/blob/main/CHANGELOG.md) ·
[原始碼](https://github.com/th1230/WebWorldEngine) ·
[問題回報](https://github.com/th1230/WebWorldEngine/issues)

MIT
