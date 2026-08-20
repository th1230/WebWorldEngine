# @webworld/three

> Three.js 的強化層。**換一個字**就有螢幕誤差 LOD、空間分割剔除與世界串流；
> 其餘的東西一個一個加，加到哪裡就有到哪裡。

它**不取代 Three.js**。你原本的 `Scene`、`Mesh`、`Material`、loader、
controls、後處理全部照樣能用；隨時可以換回去。

```bash
npm i @webworld/three
```

`three` 是 peer dependency —— 用的就是你專案裡那一份。WebGL2 與 WebGPU
兩個 renderer 都支援，同一份程式碼。

---

## 三十秒

```js
import * as THREE from 'three';
import * as WW from '@webworld/three';

const rocks = new WW.InstancedMesh(geometry, material, 10000);
for (let i = 0; i < 10000; i++) rocks.setMatrixAt(i, matrix);
scene.add(rocks);
```

沒有初始化、沒有 `update()`、沒有自己的 render loop。它是一個 `Object3D`，
加進場景就開始運作，相機從 `onBeforeRender` 拿。

`raycast`、`.position`、`traverse`、`EffectComposer`、shadow map 全部照舊。

---

## 這包裡有什麼

一個一個獨立，用不到的不會進你的 bundle。

**放東西進世界**

| | |
| --- | --- |
| [`InstancedMesh`](#instancedmesh) | 螢幕誤差 LOD + 空間分割剔除，換一個字 |
| [`load` / `loadMaterial` / `loadTexture`](#資產三條路同一個形狀) | cook 過的資產，GPU 壓縮貼圖直接餵給 GPU |
| [`scatter`](#散佈) | 「這片區域放兩萬棵樹」 |
| [`splitWithLods` / `MultiMesh`](#一份很大的幾何) | 一份大幾何切成各自選階的塊 |
| [`bakeVertexAnimation` / `AnimatedInstancedMesh`](#頂點動畫) | 一群人共用一次繪製 |
| [`bakeImpostor` / `ImpostorBatch`](#極遠處兩個三角形) | LOD 鏈的盡頭：兩個三角形 |
| [HLOD（遠景合併）](#遠景合併) | 一整格遠到該用最粗階時送一份合併幾何 |
| [遮蔽剔除](#遮蔽剔除預設關) | 被擋住的 instance 這一幀不送 |
| [換階淡入](#換階淡入) | 換階那一瞬間的跳動 |
| [`VirtualTexture`](#virtualtexture) | 貼圖比 VRAM 大 |

**世界比記憶體大**

| | |
| --- | --- |
| [`worldFor(scene).stream()`](#世界比記憶體大) | 你只回答「這一格裡有什麼」 |
| [`OriginRebase`](#座標精度走遠了畫面不抖) | 走遠了畫面不抖 |

**光**

| | |
| --- | --- |
| [`applyShadows`（CSM）](#世界尺度的陰影) | Three 的 CSM addon，補掉它兩個不報錯的坑 |
| [`VirtualShadowMap`](#virtualshadowmap) | 假裝出 32768² 的陰影圖，只配置看得到的那些頁 |
| [`ContactShadows`](#contactshadows) | 陰影圖給不出的那幾公分 |
| [`DistanceFieldShadows`](#distancefieldshadows) | 鏡頭外的東西也投得出影子 |
| [`IrradianceVolume`](#間接光探針) | 烘一格探針，陰影裡不再是全黑 |
| [`ScreenSpaceGI`](#接觸尺度的間接光螢幕空間) | 探針的格距補不到的那幾公分 |
| [`ReflectionProbes`](#reflectionprobes) | 與輻照度探針同一次拍攝的第二個產物 |
| [`TracedReflections`](#tracedreflections) | 螢幕空間 → 距離場 → 探針，三層接力 |
| [`VolumetricFog`](#volumetricfog) | 光柱，而且會被東西擋住 |
| [`GlobalDistanceField`](#globaldistancefield) | 上面那幾個共用的「世界長什麼樣」 |
| [`SkyAtmosphere`](#天空與日夜) | 大氣散射，日夜循環 |

**地形、水、物理**

| | |
| --- | --- |
| [`buildTerrain` / `buildHeightfield`](#地形) | 畫的那份與碰撞那份同一個高度函式 |
| [`Water` / `WaterSurface` / `computeBuoyancy`](#水) | 一份波形，畫面、CPU、浮力三邊共用 |
| [`PhysicsScheduler`](#物理調度) | 誰要進求解器 |

**其他**

| | |
| --- | --- |
| [`worldFor(scene).stats`](#資訊出口) | 這一幀到底發生了什麼 |
| [`debugMode`](#查問題把中間值畫出來) | 效果沒生效時，把中間值畫出來看斷在哪一段 |
| [兩個後端](#兩個後端) | WebGL2 與 WebGPU 的差別在哪裡 |
| [品質契約](#品質契約) | LOD 保證的是什麼、不保證什麼 |

---

## 一幀長什麼樣子

畫面用的那幾個效果（陰影、霧、反射、間接光）都吃**同一張深度法線圖**。
那張圖一幀只該畫一次，而「一幀」只有你知道 —— 所以每幀開頭講一聲：

```js
const world = WW.worldFor(scene);

function frame() {
  world.beginFrame();

  const shadow = contact.render(renderer, scene, camera, { lightDirection });
  const fog = volumetric.render(renderer, scene, camera, { lightDirection, lightColor });

  renderer.render(scene, camera);
  composite(shadow, fog);            // 怎麼合成是你的事
  requestAnimationFrame(frame);
}
```

每個效果**自己去拿**那張圖，第一個要的人觸發，其餘的人拿同一份。你不必
建它、不必每幀更新它、也不會弄錯順序。

漏了 `beginFrame()` 的話畫面還是對的，只是同一張圖一幀畫了好幾次 ——
套件會在主控台講一次，因為那種浪費從外面看不出來。

**每個效果都是這個形狀**：

```js
effect.render(renderer, scene, camera, { /* 這一幀會變的東西 */ });  // → Texture | null
```

回傳一張圖而不是直接畫上去 —— 合成要怎麼做（加？乘？先做色調對應？）是你的
選擇，套件不替你決定。還沒準備好時回 `null`（WebGPU 上材質是非同步建的）。

想調那張共用圖的解析度：

```js
world.setDepthNormals({ scale: 1 });   // 預設 0.5
```

---

## InstancedMesh

```diff
- const rocks = new THREE.InstancedMesh(geometry, material, 10000);
+ const rocks = new WW.InstancedMesh(geometry, material, 10000);
```

底層是 `THREE.BatchedMesh` —— `InstancedMesh` 一次只能畫一份幾何，逐 instance
的 LOD 在它上面做不到。刻意列出差異，因為靜默的差異比明講的危險：

| | 差異 |
| --- | --- |
| `.geometry` | 回傳**內部合併後**的幾何。你傳進來的那份在 `.sourceGeometry` |
| `.isInstancedMesh` | **沒有**這個旗標（有 `.isBatchedMesh`） |
| `.count` | 語意相同（只畫前 N 個） |
| `.instanceMatrix` | 有，而且與內部儲存共用同一塊記憶體，`needsUpdate` 照常有效 |

## 資產：三條路，同一個形狀

```js
new WW.InstancedMesh(geometry, material, n);                     // 在 worker 裡自動產生 LOD
new WW.InstancedMesh({ lods, errors }, material, n);             // 自備 LOD 鏈
new WW.InstancedMesh(await WW.load(manifest, id), material, n);  // cook 過的資產
```

**cook 是選配的加速，不是門檻。** 只給一份 `BufferGeometry` 也會有完整的
LOD 鏈 —— 產生在 worker 裡，不卡主執行緒。

材質走同一條路，而且拿到的就是 `THREE.MeshStandardMaterial`：

```js
const material = await WW.loadMaterial(manifest, 'mesh:rock');
material.envMapIntensity = 0.6;   // 原本那個屬性，原本那樣用
```

`.ktx2` 裡的 BC 資料**直接餵給 GPU**：沒有解碼、沒有 `ImageBitmap`、沒有
主執行緒上的像素展開。一張 1024² 貼圖在 VRAM 裡從 RGBA8 的 5.3 MB 降到
BC7 的 1.4 MB。

單張貼圖用 `WW.loadTexture(manifest, id)`；不用了用 `WW.releaseMaterial()`
（有參考計數）。

> **在 WebGPU 上要接套件的著色功能**（間接光、頂點動畫、換階淡入、虛擬貼圖）
> 的話，材質必須是 node 材質：
>
> ```js
> import { MeshStandardNodeMaterial } from 'three/webgpu';
> const material = await WW.loadMaterial(url, id, { MaterialClass: MeshStandardNodeMaterial });
> ```
>
> 見[兩個後端](#兩個後端)。

## 遠景合併

遠處的物件幾乎不花三角形，卻各自付一次完整的繪製成本。一整格都遠到該用
最粗階時，改送一份烘好的合併幾何：

| | 開 | 關 |
| --- | ---: | ---: |
| 繪製次數 | **2,094** | 27,418 |
| GPU | **2.06 ms** | 6.59 ms |
| 幀 p95 | **6.40 ms** | 16.20 ms |

**畫質不變** —— 只有本來就在最粗階的會被合併，該用細節的一個都不動。

合併幾何住在一池可重用的槽位裡，按需要換內容（最久沒畫到的先回收），
所以記憶體需求是「**同時看得見多少**」而不是「世界有多大」。實測一百萬個
instance：同樣 64 MB 預算下合併 5,274 格，幀 p50 45.30 ms。

烘焙是惰性的，每幀最多花 2 ms。還沒烘好的格子照原本逐 instance 送 ——
畫面正確，只是那幾幀還沒省到。

預設開啟。`{ hlod: false }` 關掉；`{ hlodBudgetMB }` 調記憶體上限（預設 64）
—— 合併等於把最粗階複製一份，超過預算就不啟用並且在 console 說明原因。

## 換階淡入

```js
new WW.InstancedMesh(geometry, material, n, { lodFadeBand: 0.25 });
```

換階那一瞬間形狀會跳一下。`0.25` 代表「過了換階門檻之後再走 25% 的距離，才
完全換到粗階」—— 中間那一段兩階同時畫，用互補的抖動遮罩各自丟掉一半像素。

**預設是關的**，因為量過了：散開的兩萬顆石頭在推鏡頭時，最忙的一幀只有 75 顆
換階（0.4%）—— 那看不見，而淡入要為它多畫一次。密集排列的內容才明顯（同樣
兩萬顆量到 692 顆），那時候再開。

它需要材質接得上（WebGL 走 `onBeforeCompile`，WebGPU 走 `maskNode`）——
接不上時會在主控台講，而不是靜靜地沒有淡入。

## VirtualTexture

貼圖比 VRAM 大的時候：切成頁，只把看得到的那些頁放進圖集。

```js
const vt = new WW.VirtualTexture({
  pageSize: 128,
  pagesPerSide: 64,        // 等於一張 8192² 的貼圖
  atlasPages: 8,           // 圖集裡同時放 8×8 = 64 頁
  border: 4,
  page(level, px, py, size) {
    return loadPagePixels(level, px, py, size);   // Uint8Array 或 Promise
  },
});

vt.apply(material);        // 接到材質上
vt.request(level, px, py); // 我要這一頁
vt.update(8);              // 每幀，最多花 8 ms 把要的頁搬進圖集
```

邊界那一圈 `border` 是給雙線性取樣用的 —— 沒有的話頁與頁之間會有一條縫，
而那條縫只在特定的縮放比例下看得到。

## 世界比記憶體大

```js
WW.worldFor(scene).stream({
  cellSize: 120,
  radius: 600,
  load(cx, cz, place) {
    for (let i = 0; i < 400; i++) place(rocks, matrix.compose(/* … */));
  },
});
```

你只回答一個問題：**這一格裡有什麼**。何時載入、何時卸載、先載哪一個、
一幀載幾個、邊界上怎麼不抖 —— 全部是套件的事。

不呼叫 `stream()` 的話一切照常，只是內容全部常駐。

開了之後 `world.streaming` 是那個 `WorldStream`，`.stats` 上有
常駐、載入中、待處理與失敗的數量。

## 座標精度：走遠了畫面不抖

```js
const rebase = new WW.OriginRebase({ onRebase: (offset) => sun.position.add(offset) });
rebase.add(rocks);
rebase.update(camera);   // 每幀，通常什麼都不做
```

`Float32Array` 在離原點十萬單位處的間距是 0.008 —— 公分級的細節開始塌陷，
症狀是**畫面在抖**，而且不會報錯、不會出現在任何幀時間上。做法是把世界
平移回相機腳下。`rebase.origin` 記著真正的世界座標，所以存檔與連線還問得出
「這個東西在世界的哪裡」。

---

# 光

## 世界尺度的陰影

```js
const csm = new CSM({ camera, parent: scene, cascades: 4 });
WW.applyShadows(csm, scene);   // 順序不重要
```

CSM 本身用 Three 自己的 addon。這裡補的是它的兩個坑，而兩個都**不報錯**：
`setupMaterial` 要逐材質呼叫（漏掉那份材質就完全沒有陰影），而且它是
**直接指派** `onBeforeCompile`（會蓋掉頂點動畫）。

## VirtualShadowMap

CSM 的解析度是「一整層分幾張圖」；走近一看還是糊的。虛擬陰影圖假裝出一張
非常大的圖（32768²，遠超硬體上限的 16384），但只配置**看得到的那些頁**。

```js
const vsm = new WW.VirtualShadowMap({
  pageSize: 64,
  pagesPerSide: 512,   // 64 × 512 = 32768：那就是假裝出來的解析度
  atlasPages: 32,      // 圖集 32×32 = 1,024 個槽位 —— 這才是真正的預算
  extent: 300,         // 光源覆蓋的世界範圍
  budget: 8,           // 一幀最多畫幾頁
});
vsm.setLight(lightDirection, worldCentre);

function frame() {
  world.beginFrame();

  const { u: u0, v: v0 } = vsm.worldToUv(nearCorner);
  const { u: u1, v: v1 } = vsm.worldToUv(farCorner);
  vsm.requestRegion(u0, v0, u1, v1, 0);   // 相機看得到的那一塊
  vsm.update(renderer, scene);            // 把要的頁畫進圖集（分幀）

  const mask = vsm.render(renderer, scene, camera);   // 1 = 照得到、0 = 陰影裡
}
```

`update` 是**光**那一側的事（哪些頁要重畫），`render` 是**畫面**那一側的事
（這個像素在不在陰影裡）。兩個都要每幀叫。

烘頁的那一趟自己做視錐剔除與選階 —— 陰影圖上一個 texel 對到的世界尺度與主
畫面不同，照抄主畫面的選階會在遠處畫太細。

## ContactShadows

```js
const contact = new WW.ContactShadows({ distance: 2.5, thickness: 1.2, steps: 16 });
const mask = contact.render(renderer, scene, camera, { lightDirection });
```

陰影圖不管解析度多高，都給不出「箱子貼著地面那一圈」的那幾公分 —— 那是
深度精度的下限。這一支在螢幕空間沿著光線走幾步，補的就是那一段。

`thickness` 是**厚度上限**：沒有它的話，一個浮在空中的箱子會在地面上投出
假影子（螢幕空間看不出深度差多遠）。

## DistanceFieldShadows

```js
const field = new WW.GlobalDistanceField({ resolution: 32, extent: 400 });
field.add({ volume: new WW.DistanceFieldVolume(boxGeometry), matrixWorld: box.matrixWorld });
field.update(cameraPosition);   // 每幀，分幀補格子

const shadows = new WW.DistanceFieldShadows({ steps: 64, softness: 6 });
const mask = shadows.render(renderer, scene, camera, { field, lightDirection });
```

螢幕空間的陰影只知道畫面上有的東西。距離場知道**鏡頭外**的 —— 一座在畫面
外的山照樣投得出影子。軟硬由 `softness` 控制（沿線最近距離的錐體角度）。

## 間接光探針

```js
const volume = new WW.IrradianceVolume({ min, size, resolution: [16, 4, 16] });
await WW.bakeIrradiance(renderer, scene, volume);   // 每幀一點，直到烘完
WW.applyIrradiance(volume, scene);
```

只有直接光的話陰影裡是**全黑**的，而現實中沒有全黑的陰影。這裡烘的是一格
探針，每顆存 SH L1，著色時是一次三維查表。

WebGL 與 WebGPU 兩條路都有，加的是同一個量到同一個地方。

**會動的東西也反彈得了光** —— 東西動了就把附近的探針標成過期：

```js
volume.invalidateAround(car.position, 14);   // 每幀，動了才標
```

過期的探針會插隊優先重烘。一顆 2.7 ms，所以這是「一個會動的東西，標它周圍
那幾顆」，不是「每幀重烘一整片」—— 而且間接光會慢幾幀才跟上。

**即時動態 GI（Lumen 那一類）不做** —— 那要擁有整條管線，會毀掉「換一個字」
這件事。

## 接觸尺度的間接光（螢幕空間）

```js
const ssgi = new WW.ScreenSpaceGI({ radius: 4 });
const indirect = ssgi.render(renderer, scene, camera, { color: sceneColorTexture });
```

探針記的是**格點上**的光，格點之間靠內插 —— 比格距小的東西（貼著牆的箱子、
桌腳與地板的接縫）落在縫裡。這一支從畫面上已經有的像素收集，尺度是像素級的。

**兩個一起用**：探針管大範圍與螢幕外，這裡管貼在一起的那幾公分。

它是一個後製 pass（與 bloom 同一類），吃的是那張共用的深度法線圖，所以多的
成本只有收集那一趟。`scale` 調的是收集那張圖的解析度（預設 0.5）。

限制是這個做法的本質，不是還沒做完：只收集得到**畫面上有的**、只有一次反彈、
有雜訊、被遮住的收不到。前三項正好是探針沒有的問題。

## ReflectionProbes

```js
const volume = new WW.IrradianceVolume({ min, size, resolution: [16, 4, 16] });
const reflection = new WW.ReflectionProbes(volume, { tileSize: 16 });
await WW.bakeIrradiance(renderer, scene, volume, { reflection });
```

**一次拍攝，兩個產物。** 烘輻照度時已經把 cubemap 的六個面讀回 CPU 了，而
讀回正是整件事最貴的一段（一顆 2.7 ms，其中畫只佔 0.3 ms）。反射探針要的是
同一批像素的另一種投影 —— 分開烘的話那 2.7 ms 要付兩次，換不到任何東西。

代價是兩者共用同一組探針位置與同一份過期清單。那是刻意的。

## TracedReflections

```js
const reflections = new WW.TracedReflections({ screenSteps: 32, roughness: 0.1 });
const result = reflections.render(renderer, scene, camera, {
  color: sceneColorTexture,
  field,        // 打不到畫面內的東西時，沿著距離場繼續追
  irradiance,   // 追不到的方向退回間接光
  probes,       // 有探針就優先用探針 —— 它記得畫面外的環境
});
```

三層接力，每一層補前一層的盲點：螢幕空間最準但只看得到畫面上的；距離場看得到
畫面外但沒有顏色；探針記得畫面外的顏色但是低頻的。`field`、`irradiance`、
`probes` 都是選配的 —— 只給 `color` 的話就是純螢幕空間反射。

## VolumetricFog

```js
const fog = new WW.VolumetricFog({ density: 0.004, steps: 48, anisotropy: 0.7 });
const scattered = fog.render(renderer, scene, camera, { lightDirection, lightColor, field });
```

沿著視線積分散射。`anisotropy` 是相位函數 —— 迎著光看比背著光看亮得多，那是
光柱之所以是光柱的原因。給了 `field` 的話牆後面就不會有光柱。

起點刻意抖動：不抖的話畫面上會出現規則的**條帶**，而條帶比雜訊明顯得多。

## GlobalDistanceField

```js
const field = new WW.GlobalDistanceField({ resolution: 32, extent: 400, budget: 4 });
field.add({ volume: new WW.DistanceFieldVolume(geometry, { resolution: 32 }), matrixWorld: mesh.matrixWorld });
field.update(cameraPosition);   // 每幀，最多花 budget ms
```

一張以相機為中心的三維距離場，把場上每個物件各自的距離場合成進去。上面的
距離場陰影、追蹤反射、體積霧共用它 —— 那是「世界長什麼樣」的答案，不是
哪個效果私有的東西。

三種間接光各補一段，缺一段就會露出來：

| | 看得到鏡頭外 | 角落問得出來 |
| --- | --- | --- |
| `ScreenSpaceGI` | ❌ | ✅ |
| `IrradianceVolume` | ✅ | ❌ |
| `GlobalDistanceField` | ✅ | ✅ |

它是 Lumen 那一類做法的骨幹裡**搬得過來的那一半** —— 距離場是資料（怎麼烘、
怎麼存、怎麼串流），追蹤是一個後製 pass。沒有一格需要擁有渲染管線。

## 天空與日夜

```js
const sky = new WW.SkyAtmosphere({ resolution: 64, intensity: 22 });
scene.background = sky.texture;

sky.update(renderer, sunDirection);   // 每幀。方向動得夠多才重烘
```

大氣散射烘成一張 cubemap。`update` 自己判斷要不要重烘（`threshold` 是太陽
方向的角度門檻）—— 每幀重烘是浪費，而日出日落那幾分鐘要跟得上。

---

# 地形、水、物理

## 地形

```js
const terrain = WW.buildTerrain({ size: 4000, tiles: 8, segments: 64, height });
const field = WW.buildHeightfield({ size: 4000, samples: 129, height });
```

畫的那份與碰撞那份**取自同一個高度函式**。各寫一份的症狀是角色踩在看不見
的地面上 —— 而那看起來像物理引擎壞了。

## 水

```js
const water = new WW.Water({ level: 0 });

// 波形：三邊共用同一份
water.displacementGLSL();                    // 頂點著色器用的位移
water.heightAt(x, z, t);                     // CPU 這一側的同一個水面
const forces = WW.computeBuoyancy(water, bodies, t);

// 外觀
const surface = new WW.WaterSurface({ water, absorption: [0.35, 0.045, 0.02] });
surface.setTime(t);
surface.capture(renderer, scene, camera, waterMesh);   // 折射要的那一張
waterMesh.material = surface.materialFor(renderer);
```

**一份波形，兩邊共用。** 各算各的話東西會陷進浪裡或飄在半空。

水看起來像水靠的是三件事：吸收（水越深越藍，因為紅光先被吃掉）、折射（水底
的東西被推開，推的量跟著水面斜率走）、泡沫（岸邊與浪尖）。`setParams()` 是
調它們的那一道門。

浮力回傳的是力，施加是你的事 —— 但記得 Rapier 的 `addForce` 是**持續**的，
每幀要先 `resetForces`。不清的話第 N 幀的力是 N 倍，箱子會加速射向天空
（實測 20 秒飛到 y = 183,996，而每一幀回報的力都是對的）。

## 物理調度

```js
const scheduler = new WW.PhysicsScheduler({
  activeRadius: 200, maxActive: 120, onActivate, onDeactivate,
});
```

求解交給 Rapier（或任何你選的求解器 —— 這裡只認 id，不認型別）。這一層
決定**誰要進求解器**：沒有上限的話走進密集區就有幾千個剛體同時在算。

---

# 更多幾何

## 一份很大的幾何

```js
const pieces = await WW.splitWithLods(bigGeometry, { chunks: 256 });
scene.add(new WW.MultiMesh(pieces, material));
```

掃描回來的建築、一整份地形、別人給的大 GLB —— 那些東西是**一份**幾何，
所以選階被最近的那一塊綁死：腳下要清楚，地平線那端就跟著畫最細的。

切開之後每一塊各自選階、各自剔除，而繪製次數不變。實測一份 288 萬個三角形
的地面，相機貼著地面看遠方：

| | GPU | 送出的三角形 |
| --- | ---: | ---: |
| 整片一份 | 6.665 ms | 2,880,546 |
| 切成 256 塊 | **1.934 ms** | **84,866** |

畫面差異 0.04% —— 品質契約照樣守住。

切出來的塊**一定會鎖邊界簡化**，不然相鄰兩塊的共用邊會各自被化成不同的
樣子，中間裂開一條縫。那不是選項，因為切出來的東西沒有別的正確用法。

只要切、不要 LOD 的話用 `WW.splitGeometry(geometry, { chunks })` ——
逐塊剔除照樣有。

## 極遠處：兩個三角形

```js
const baked = WW.bakeImpostor(renderer, tree, { views: 16 });
const forest = new WW.ImpostorBatch(baked, 20000);
forest.setMatrixAt(i, matrix);
```

繞著物件烘一圈方向的圖，遠處用一個朝向相機的看板代替它。LOD 鏈的盡頭是
「還看得出形狀的網格」，這個是**兩個三角形**。

它是個近似，所以有一條成立的線 —— 而那條線是距離。實測兩萬棵樹：

| 相機距離 | 省 | 畫面差異 |
| ---: | ---: | ---: |
| 300 | 60.0% | 31.20% |
| 700 | 65.0% | 7.94% |
| **1,500** | **90.4%** | **0.01%** |
| 3,000 | 96.1% | 0.00% |

近處**明顯不對**，遠處看不出差別。所以它不是「開了就好」的東西：你要決定
多遠之後換過去，而上面那張表是量那條線的方法。

（那個省下來的百分比是對**沒有 LOD** 的幾何比的，偏樂觀。與接長鏈的最粗階
相比大約是 4 倍 —— 那 4 倍是任何 LOD 鏈都到不了的。）

## 遮蔽剔除（預設關）

```js
new WW.InstancedMesh(geometry, material, n, { occlusion: true });
```

把**確定被別的東西擋住**的 instance 從這一幀拿掉。它在「少數大遮蔽物」的
內容上有效 —— 牆、山、建築各自穩穩蓋住一大塊。

**在密集散佈的小東西上它幾乎剔不到東西。** 那不是沒調好：遮蔽物只能用
內接盒、被測物要用外接球，兩層保守相乘之後通不過。實測兩萬顆石頭的場景
剔掉 0 個，而每幀多花 1–4 ms 的 CPU。

所以預設是關的，而且開著連續 120 幀幾乎剔不到東西的話它會**警告** ——
開了沒效果是看不見的，而看不見的浪費最貴。

要判斷值不值得就看這兩個數字：

```js
rocks.stats.occluded;              // 拿掉了幾個
rocks.stats.cpuParts.occlusion;    // 為此花了多少 CPU
```

## 散佈

```js
WW.scatter({ count: 20000, area, align: 'terrain', height });
```

「這片區域放兩萬棵樹」是宣告式的，而不是你自己寫一個亂數迴圈然後每次專案
重寫一遍。

## 頂點動畫

```js
const baked = WW.bakeVertexAnimation(mesh, clip, { frames: 32 });
const crowd = new WW.AnimatedInstancedMesh(baked, material, 2000);
```

骨骼動畫一個物件一次繪製；烘成貼圖之後整群人共用一次。WebGL 與 WebGPU
兩條路都有 —— 只做一邊的症狀是**一群停在綁定姿勢的模型，不報錯，幀時間
還特別好看**。

---

## 兩個後端

同一份程式碼在 `WebGLRenderer` 與 `WebGPURenderer` 上都跑，但底下是兩份
實作：WebGL 注入 GLSL（`onBeforeCompile`），WebGPU 設 node（`positionNode`、
`colorNode`、`maskNode`）。兩份的一致性由一道跨後端關卡逐項比對。

你需要知道的只有兩件事：

**一、WebGPU 上那幾個功能要 node 材質。** `WebGPURenderer` 從不呼叫
`onBeforeCompile`，而一個普通的 `MeshStandardMaterial` 在你手上**不是** node
材質（換掉是 renderer 內部做的）。所以：

```js
import { MeshStandardNodeMaterial } from 'three/webgpu';
const material = await WW.loadMaterial(url, id, { MaterialClass: MeshStandardNodeMaterial });
```

接不上的時候套件會在主控台講 —— 症狀否則是「這個功能靜靜地沒有發生」。

**二、node 材質是非同步建的。** `three/tsl` 與 `three/webgpu` 是動態載入的
（只用 WebGL 的人不該下載那一半，這件事有一道關卡守著），所以第一幀可能還
沒好。那些回傳 `Texture | null` 的地方，`null` 就是「還沒好」。等得到：

```js
await WW.irradianceNodeReady(volume);
await WW.skyNodeReady(sky);
```

## 查問題：把中間值畫出來

效果沒生效的時候，最難的是**不知道斷在哪一段**。所以幾個多段的效果都
開了同一個口：

```js
contact.debugMode = 1;      // 接觸陰影
reflections.debugMode = 3;  // 追蹤反射：0 正常、1 體積座標、2 反射方向、3 第 0 顆探針…
vsm.debugMode = 1;          // 虛擬陰影圖
surface.debugMode = 10;     // 水（10 是折射偏移）
```

`0` 一律是「正常畫」。其餘的號碼各效果自己定義，寫在各自的 node 檔裡 ——
兩條後端的號碼**是一樣的**，所以 WebGL 上看到什麼，WebGPU 上就該看到什麼。
這個口本來就是為了查跨後端的差異加的。

> 水的那個是 setter 而不是普通欄位，因為 `materialFor()` 會把號碼烘進材質，
> 必須立刻推給兩條路。其他三個在繪製當下才讀，欄位就夠了。

## 資訊出口

```js
const world = WW.worldFor(scene);
world.stats;              // { objects, instances, visible, tested, cells, … }
world.streaming?.stats;   // { resident, loading, pending, failedLoads, … }
rocks.stats;              // { visible, tested, levels, cpuMs, spatial }
```

**引擎不會因為機器慢就自己降級。** 那是政策，屬於你 —— 引擎的責任是
「不管拿到多少資源都不浪費」，不是「替你決定放棄什麼」。

## 工具與雜項

零散但真的會用到的：

| | |
| --- | --- |
| `readPixelsAsync(renderer, target, x, y, w, h, alloc)` | 非同步讀回 GPU 像素，不卡住管線（WebGL 走 PBO，WebGPU 走它自己的路） |
| `world.depthNormals(renderer, camera)` | 那張共用的 `SceneDepthNormals`。要寫自己的 pass 時拿它的 `depthTexture` / `normalTexture` |
| `translateObject(object, offset)` | 平移一個物件，含它內部的 instance 資料。`OriginRebase` 用的就是它 |
| `clearAssetCache()` / `disposeBakeCache(renderer)` | 換關卡時把 manifest 與烘焙用的暫存放掉 |
| `DEFAULT_WAVES` | `Water` 預設的那組波。要改先從它複製一份 |
| `PageTable` | 虛擬貼圖與虛擬陰影圖共用的頁表。自己做分頁資源時用得到（轉出自 `@webworld/format`） |

自己組 LOD 鏈的話還有這幾個 —— `InstancedMesh` 內部用的就是它們：

```js
WW.sphericalLodErrors(geometries);             // 一串由細到粗的幾何 → 每階的誤差
WW.pixelsPerUnit(viewportHeight, fovYRadians); // 一世界單位在螢幕上佔幾個像素
WW.selectLevel(errors, perMetre, errorPixels); // 這個距離該用哪一階
WW.isLodChain(source);                         // 傳進來的是幾何還是鏈
```

寫自己的材質要支援[換階淡入](#換階淡入)的話，`LOD_FADE_VERTEX_GLSL`、
`LOD_FADE_FRAGMENT_GLSL` 與 `LOD_FADE_CAPACITY` 是那條路上要的東西。

## 品質契約

LOD 選階的保證是：**被選中的階，其幾何誤差投影到螢幕上 ≤ `errorPixels`
（預設 2）**。這是位置誤差的上限，**不涵蓋法線與著色**。

放寬 `errorPixels` 就是拿畫質換效能 —— 它是個旋鈕，預設不動它。

## 範圍

桌機瀏覽器。WebGL2 與 WebGPU 都可以；行動裝置不在範圍內 —— 不是「還沒做」，
是無法驗證：ETC2／ASTC 沒有任何桌機能解碼，寫出來的編碼器只能用自己的解碼器
驗，那證明不了任何事。

MIT
