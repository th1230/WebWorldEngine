# @webworld/three

> Three.js 的強化層。**換一個字**就有螢幕誤差 LOD、空間分割剔除與世界串流。

它**不取代 Three.js**。你原本的 `Scene`、`Mesh`、`Material`、loader、
controls、後處理全部照樣能用；隨時可以換回去。

```bash
npm i @webworld/three
```

`three` 是 peer dependency —— 用的就是你專案裡那一份。

## 換一個字

```diff
- const rocks = new THREE.InstancedMesh(geometry, material, 10000);
+ const rocks = new WW.InstancedMesh(geometry, material, 10000);
  for (let i = 0; i < 10000; i++) rocks.setMatrixAt(i, matrix);
  scene.add(rocks);
```

沒有初始化、沒有 `update()`、沒有自己的 render loop。它是一個 `Object3D`，
加進場景就開始運作，相機從 `onBeforeRender` 拿。

`raycast`、`.position`、`traverse`、`EffectComposer`、shadow map 全部照舊。

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

## 構建世界要的其他東西

這些都是「不做就得自己重寫一次，而且第一次一定會漏掉」的那一類。每一項
都是獨立的，用不到就不會進你的 bundle。

### 座標精度：走遠了畫面不抖

```js
const rebase = new WW.OriginRebase({ onRebase: (offset) => sun.position.add(offset) });
rebase.add(rocks);
rebase.update(camera);   // 每幀，通常什麼都不做
```

`Float32Array` 在離原點十萬單位處的間距是 0.008 —— 公分級的細節開始塌陷，
症狀是**畫面在抖**，而且不會報錯、不會出現在任何幀時間上。做法是把世界
平移回相機腳下。`rebase.origin` 記著真正的世界座標，所以存檔與連線還問得出
「這個東西在世界的哪裡」。

### 世界尺度的陰影

```js
const csm = new CSM({ camera, parent: scene, cascades: 4 });
WW.applyShadows(csm, scene);   // 順序不重要
```

CSM 本身用 Three 自己的 addon。這裡補的是它的兩個坑，而兩個都**不報錯**：
`setupMaterial` 要逐材質呼叫（漏掉那份材質就完全沒有陰影），而且它是
**直接指派** `onBeforeCompile`（會蓋掉頂點動畫）。

### 地形

```js
const terrain = WW.buildTerrain({ size: 4000, tiles: 8, segments: 64, height });
const field = WW.terrainHeightfield({ size: 4000, samples: 129, height });
```

畫的那份與碰撞那份**取自同一個高度函式**。各寫一份的症狀是角色踩在看不見
的地面上 —— 而那看起來像物理引擎壞了。

### 水，以及浮在水上

```js
const water = new WW.Water({ level: 0 });
water.displacementGLSL();                    // 頂點著色器用的位移
water.heightAt(x, z, t);                     // CPU 這一側的同一個水面
const forces = WW.computeBuoyancy(water, bodies, t);
```

**一份波形，兩邊共用。** 各算各的話東西會陷進浪裡或飄在半空。

浮力回傳的是力，施加是你的事 —— 但記得 Rapier 的 `addForce` 是**持續**的，
每幀要先 `resetForces`。不清的話第 N 幀的力是 N 倍，箱子會加速射向天空
（實測 20 秒飛到 y = 183,996，而每一幀回報的力都是對的）。

### 物理調度

```js
const scheduler = new WW.PhysicsScheduler({
  activeRadius: 200, maxActive: 120, onActivate, onDeactivate,
});
```

求解交給 Rapier（或任何你選的求解器 —— 這裡只認 id，不認型別）。這一層
決定**誰要進求解器**：沒有上限的話走進密集區就有幾千個剛體同時在算。

### 間接光

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

### 接觸尺度的間接光（螢幕空間）

```js
const ssgi = new WW.ScreenSpaceGI({ radius: 4 });
// 主畫面畫好之後：
const indirect = ssgi.render(renderer, scene, camera, sceneColorTexture);
```

探針記的是**格點上**的光，格點之間靠內插 —— 比格距小的東西（貼著牆的箱子、
桌腳與地板的接縫）落在縫裡。這一支從畫面上已經有的像素收集，尺度是像素級的。

**兩個一起用**：探針管大範圍與螢幕外，這裡管貼在一起的那幾公分。

它是一個後製 pass（與 bloom 同一類），多的成本是一次法線重畫 —— 那跟著場景
複雜度走，要自己量。合成怎麼做是你的選擇，所以它回傳一張圖而不是直接畫上去。

限制是這個做法的本質，不是還沒做完：只收集得到**畫面上有的**、只有一次反彈、
有雜訊、被遮住的收不到。前三項正好是探針沒有的問題。

### 一份很大的幾何

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

### 遮蔽剔除（預設關）

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

### 散佈

```js
WW.scatter({ count: 20000, area, align: 'terrain', height });
```

「這片區域放兩萬棵樹」是宣告式的，而不是你自己寫一個亂數迴圈然後每次專案
重寫一遍。

### 頂點動畫

```js
const baked = WW.bakeVertexAnimation(mesh, clip, { frames: 32 });
const crowd = new WW.AnimatedInstancedMesh(baked, material, 2000);
```

骨骼動畫一個物件一次繪製；烘成貼圖之後整群人共用一次。WebGL 與 WebGPU
兩條路都有 —— 只做一邊的症狀是**一群停在綁定姿勢的模型，不報錯，幀時間
還特別好看**。

## 資訊出口

```js
const world = WW.worldFor(scene);
world.stats;              // { objects, instances, visible, tested, cells, … }
world.streaming?.stats;   // { resident, loading, pending, failedLoads, … }
rocks.stats;              // { visible, tested, levels, cpuMs, spatial }
```

**引擎不會因為機器慢就自己降級。** 那是政策，屬於你 —— 引擎的責任是
「不管拿到多少資源都不浪費」，不是「替你決定放棄什麼」。

## 品質契約

LOD 選階的保證是：**被選中的階，其幾何誤差投影到螢幕上 ≤ `errorPixels`
（預設 2）**。這是位置誤差的上限，**不涵蓋法線與著色**。

放寬 `errorPixels` 就是拿畫質換效能 —— 它是個旋鈕，預設不動它。

## 與 `THREE.InstancedMesh` 不同的地方

刻意列出來，因為靜默的差異比明講的危險：

| | 差異 |
| --- | --- |
| `.geometry` | 回傳**內部合併後**的幾何。你傳進來的那份在 `.sourceGeometry` |
| `.isInstancedMesh` | **沒有**這個旗標（有 `.isBatchedMesh`） |
| `.count` | 語意相同（只畫前 N 個） |
| `.instanceMatrix` | 有，而且與內部儲存共用同一塊記憶體，`needsUpdate` 照常有效 |

底層是 `THREE.BatchedMesh` —— `InstancedMesh` 一次只能畫一份幾何，
逐 instance 的 LOD 在它上面做不到。

## 範圍

桌機瀏覽器。WebGL2 與 WebGPU 都可以；行動裝置不在範圍內。

MIT
