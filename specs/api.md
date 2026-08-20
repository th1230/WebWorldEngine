# 邊界契約：使用者實際寫的程式碼

這份文件定義**唯一重要的介面** —— 使用者與這個套件之間那一層。

它排在所有內部設計之前 —— 邊界決定所有內部結構，邊界錯了內部重構就白做。

---

## 一、分界線：誰管什麼

這個套件**不重包 Three.js**。那個工作量無邊無際，而且不是目的。

| 領域 | 誰說了算 |
| --- | --- |
| **交給套件的東西**（大量放置、剔除、LOD、串流） | **套件的定義。** 選擇用它就接受它的處理方式 |
| **沒交給它的東西**（角色、UI、後處理、控制器、你自己的 mesh） | **完全不受影響**，原生 Three.js |

「相容」的意思是**第二欄不受干擾**，不是「第一欄要能吃任何形狀的輸入」。

想把任意既有的 `Object3D` 階層丟進來「自動變快」—— 那是魔法加速器。它必須
對使用者的結構做推測，而推測錯的症狀是「畫面少了東西」且毫無線索。不做。

---

## 二、兩類概念，各有各的規則

### 第一類：Three.js 已經有的概念 → A/B 替換

原本某段邏輯用 Three.js 寫，想要強化過的能力，就**把類別換成套件的對應版**，
其他一行都不動：

```js
// 原本
const rocks = new THREE.InstancedMesh(geometry, material, 10000);
for (let i = 0; i < 10000; i++) rocks.setMatrixAt(i, m);
scene.add(rocks);

// 換成
const rocks = new WW.InstancedMesh(geometry, material, 10000);   // ← 只有這行變
for (let i = 0; i < 10000; i++) rocks.setMatrixAt(i, m);         // ← 一模一樣
scene.add(rocks);                                                 // ← 一模一樣
```

**建構參數一樣、方法一樣、用法一樣。** 而且它**本身就是 Three.js 物件**
（繼承 `Object3D`），所以 `scene.add`、`raycast`、`.position`、`traverse`
全部照舊 —— 這個套件本質上就是 Three.js 包起來的。

換回 `THREE.InstancedMesh` 是**一個字的差別**，程式照樣跑，只是沒有優化。

### 第二類：套件才有的能力 → 必須自己定義概念

Three.js 沒有串流、沒有空間分割、沒有資產烘焙。硬套既有詞彙只會扭曲。

**這一類會產生真實的前置依賴** —— 你要串流，就必須先有格子、來源、半徑。
那不是設計失誤，是能力本身的要求。

設計紀律是**把前置鏈壓到最短**（見第四節）。

> 判準：**新概念要對應到真實存在的新東西**，不是同一件事的新說法。

---

## 三、盤點：Three.js 已經有什麼，缺什麼

以下對照 **three@0.185.1 實際的程式碼**，不是印象。

### Three.js 已經有的（不要重造）

| 能力 | 在哪 |
| --- | --- |
| 逐物件視錐剔除 | `Scene` 走訪時做 |
| **逐 instance 視錐剔除** | `BatchedMesh.perObjectFrustumCulled`（**預設開啟**） |
| **多幾何合批** | `BatchedMesh.addGeometry` / `addInstance` |
| 繪製排序 | `BatchedMesh.sortObjects` |
| **LOD 含遲滯** | `LOD.addLevel(object, distance, hysteresis)` |
| Instancing | `InstancedMesh.setMatrixAt` |

**這一欄本來就有。** 任何「我們提供 instancing／逐 instance 剔除」的說法
都是在重造輪子。

### Three.js 缺的（這個套件的價值所在）

| 缺口 | 為什麼重要 |
| --- | --- |
| **LOD 依螢幕誤差選階** | `THREE.LOD` 用的是**原始距離** —— 不看物件多大、不看 fov、不看視埠。同樣距離下一顆大石與一顆小石會選到同一階 |
| **LOD 鏈自動產生** | Three 要你自己準備好每一階的幾何 |
| **空間分割剔除** | Three 每幀走訪整棵樹逐一測試。10 萬個物件就是 10 萬次，而整片區域可以一次跳過 |
| **`LOD` 無法規模化** | `THREE.LOD` 是一個 `Object3D` 裝多階 —— 一萬個 LOD 物件就是一萬個 `Object3D` |
| **串流** | 世界比記憶體大時的載入卸載，完全沒有 |
| **資產烘焙** | 壓縮貼圖、切線、網格最佳化、LOD 鏈，全部要自己來 |
| **增量更新** | 靜態內容每幀重算矩陣、重傳 buffer |
| **Worker 卸載** | 全部在主執行緒 |
| **遮擋剔除** | 沒有 |
| **GPU 驅動繪製** | 沒有 |
| **HLOD / impostor** | 沒有 |
| **引擎層級的診斷** | `renderer.info` 只有 draw call 與三角形數 |

---

## 四、上下文用「發現」的，不是用「要求」的

每一句「你要先做 A B C，D 才會有效」都是負擔。所以要分辨：

| 能力 | 真的需要前置嗎 |
| --- | --- |
| 單一物件的剔除、LOD、增量更新 | **不需要** |
| 跨物件合批、共用預算 | **需要** —— 物件之間要互相知道 |
| 串流、統計、能力查詢 | **需要** —— Three.js 沒有對應概念 |

所以：

```js
// 最簡：零設定。它是 Object3D，加進 scene 就開始運作
scene.add(new WW.InstancedMesh(geometry, material, 10000));

// 只有要用套件獨有的功能、或要調參數時，才需要拿到 world
const world = WW.worldFor(scene);
world.stream({ cellSize: 120, radius: 600, load: (cx, cz, place) => { … } });
world.stats;
world.capabilities;
```

第一個加進 scene 的 `WW.*` 物件會**自己去找（或建立）那個 scene 上的共用
上下文**。最常見的情況下，使用者不需要知道它存在。

### 相機從哪來

`onBeforeRender` 的參數就帶著相機 —— 剔除需要的東西剛好都有。

不要求使用者傳相機，因為那等於要求他保證「這個相機就是之後 render 用的
那個」。多相機或多 render target 的專案裡那個假設會錯，而錯的形式是
**畫面剔掉不該剔的東西**。掛在 `onBeforeRender` 上則每次 render 都正確。

---

## 五、缺前置的時候必須大聲

這整個專案最反覆出現的失效形態是「**看起來成功了**」。

所以：**如果某個能力真的需要前置而它不在，要明確講出缺什麼、以及少了它
會怎樣。** 絕不能靜默退化成沒有優化的版本 —— 那會讓人以為自己在用強化版。

```text
✗ 靜默地不做 LOD
✓ WW.InstancedMesh: 沒有 LOD 鏈可用，這個物件會一直用最細的幾何。
  傳入 geometry 時套件會自動產生；若你自己指定了 lods 但只有一階，
  就是這個情況。
```

---

## 六、畫進使用者的 scene，不自己 render

這是整份契約的地基。

自己 render 的話，使用者的後處理、他自己加的物件、shadow map、
`scene.background` 全部要重接一次 —— 那是取代，不是強化。

代價是我們只能透過 `Object3D` 這層溝通，失去部分繪製順序的掌控。
**用一部分掌控權換完整相容性 —— 相容性是硬約束，繪製順序不是。**

並存而非接管：

```js
scene.add(character);                                    // 他的，套件不碰
scene.add(new WW.InstancedMesh(geo, mat, 10000));        // 套件管的
```

`character` 走原生 Three.js 的全部路徑 —— 動畫、raycast、後處理，一切照舊。

---

## 七、資產：三種輸入，一路往上加速

```js
// 1. 你手上的東西 —— 直接用，套件在 worker 裡替你產 LOD 鏈
new WW.InstancedMesh(geometry, material, count);

// 2. 自己準備好的階
new WW.InstancedMesh({ lods: [geo0, geo1, geo2] }, material, count);

// 3. cook 過的資產 —— 最快，但不是必要條件
const manifest = '/cooked/assets.manifest.json';
new WW.InstancedMesh(await WW.load(manifest, 'mesh:rock'), material, count);
```

第一種是**預設路徑**。第三種把工作搬到 build 時做，換取更小的下載量與
零啟動成本。

> **cook 是選配的加速，不是門檻。** UE 讓你拖檔案進去就能用，優化是它
> **替你做**，不是它**跟你要**。

### 材質走同一條路

```js
const material = await WW.loadMaterial(manifest, 'mesh:rock');
```

回傳的是 `THREE.MeshStandardMaterial` —— 就是不用這個套件時會自己寫的那個
類別，所有既有的東西（後處理、`onBeforeCompile`、換材質、每一個屬性）照樣
成立。換掉的只有「把 cook 過的貼圖接上去」那幾行。

第二個參數收材質 id 或**網格 id**：cooker 的材質命名是內部的，使用者手上
有的是網格 id，所以網格自己記著該用哪個材質。

貼圖依 URL 快取並且**回傳同一個 `Texture` 實例**。十個材質共用一張貼圖時
GPU 上就是一份 —— 各自建一個 `Texture` 包同一份位元組的話，Three 會依實例
上傳，VRAM 直接乘以十而畫面完全正常。

---

## 八、資訊出口：給開發者做決定，不是引擎自己決定

```js
world.stats        // { visible, drawCalls, triangles, cpuMs, gpuMs }
world.capabilities // { backend, tier, maxTextureSize, timestampsAvailable }
```

**引擎不會因為 tier 低就自己降級。** 那是政策，屬於開發者：

```js
if (world.capabilities.tier < 2) world.stream({ ...options, radius: 400 });
```

引擎的責任是「不管拿到多少資源都不浪費」，不是「替使用者決定放棄什麼」。

---

## 九、這份契約反推出的內部要求

每一條都是介面**逼出來的**，不是先有設計再找理由：

| 介面承諾 | 內部必須改的 |
| --- | --- |
| 畫進使用者的 scene | `render-three` 不能自己 `new Scene()` |
| `WW.*` 是 `Object3D` | 對外型別繼承 Three.js 的類別，不是自有階層 |
| 沒有 `update()` | 更新掛在 `onBeforeRender`，相機從那裡拿 |
| 上下文用發現的 | scene 上掛一個共用上下文，第一個 `WW.*` 物件建立它 |
| 吃 `BufferGeometry` | 匯入不能只認 `.wwm`；runtime 要能在 worker 產 LOD |
| 使用者不碰內部概念 | 內部套件完全不出現在對外 export |
| 漸進採用 | 沒有全域初始化；多個 scene 各有各的上下文 |
| 一萬個 instance | 放置要批次寫入，不能一次一個 command buffer |

---

## 十、實作之後定案的事

`packages/three` 做出來之後，第九節那些「內部要求」不再是推測。以下是
**被實作逼出來的決定**，不是紙上的偏好：

### `WW.InstancedMesh` 繼承 `THREE.BatchedMesh`

原本留白的是「該從 `InstancedMesh` 還是 `BatchedMesh` 繼承」。答案是
`BatchedMesh`，而且理由是硬的：

- `InstancedMesh` 一次只能畫一份幾何 → **逐 instance 的 LOD 做不到**
- 在它上面做剔除只能「把可見的矩陣壓到陣列前段再設 `count`」→
  **每幀重傳整個矩陣緩衝**，而且使用者的索引 `i` 會指向別人
- `BatchedMesh` 的 indirect texture 讓繪製順序與資料位置解耦：剔除與選階
  只改一張索引表，矩陣一個位元組都不動

代價是三個**明講的**不相容（靜默的差異比明講的危險得多）：

| | 差異 |
| --- | --- |
| `.geometry` | 回傳內部合併後的幾何。使用者傳進來的那份在 `.sourceGeometry` |
| `.isInstancedMesh` | 沒有這個旗標（有 `.isBatchedMesh`） |
| `.instanceMatrix` | **有**，而且與內部儲存共用同一塊記憶體，`needsUpdate` 照常有效 |

### 靜態是宣告出來的：`dynamic`

空間格建一次用一輩子，所以它只對靜態內容划算 —— 而**內容是不是靜態，
開發者早就知道**。所以這是一個宣告，不是引擎去猜的東西
（doctrine 的二問）。

| 你寫的 | 引擎做的 |
| --- | --- |
| `dynamic: true` | 不建格子。矩陣愛怎麼動就怎麼動，**不猜也不警告** |
| `dynamic: false` | 永遠用格子。矩陣真的一直在變時警告你宣告錯了，但**不換策略** |
| 省略（預設） | 當靜態。量到「重建比它省下的走訪還貴」時暫停格子，說出來，矩陣停下來就恢復 |

兩件事要一起看：

- **暫停的判準是量出來的**，不是「連續 N 幀」那種我訂的門檻。成本是這台
  機器上剛剛花掉的重建時間，收益是「沒被走訪到的 instance 數 × 實測的
  每個 instance 走訪成本」。
- **暫停會被說出來，而且 `stats.spatial` 讀得到。** 只有讀 console 才知道
  的行為變化是錯的設計 —— 程式也要判斷得出來。

靜默退化成「用了跟沒用一樣」，正是這個專案最常見的失效形態。

### 遠景合併的預算：`hlodBakeMs`

烘合併幾何花的是**開發者的幀預算**，所以上限是他的（doctrine 的三問）。
預設 2 ms，而且**每幀至少烘一格** —— 一格的成本可能超過整個預算，純看
預算會讓慢機器永遠停在未合併的狀態。

### 串流的 payload 是「交出去」而不是「回傳一個陣列」

原本規劃的 `load: (cx, cz) => [{ mesh, matrix }, …]` 有一個必然會咬人的陷阱：

```js
[m.makeTranslation(a), m.makeTranslation(b)]   // 兩筆指向同一個 m
```

重複使用暫存 `Matrix4` 是 Three.js 到處都在做的事，而回傳陣列會讓每一筆都
指向被改到最後一次的那個物件。症狀是**整格的東西疊在同一個點上**，而數量、
統計、幀時間全部正常。

所以介面是 `load(cx, cz, place)`：`place(mesh, matrix)` 立刻複製，正確的
寫法就是自然的那一個。**介面的形狀要讓對的用法是最順手的那一個**，
而不是靠文件叫人小心。

### LOD 鏈的誤差是必填的

`{ lods }` 一定要配 `{ errors }`，缺了就丟例外。這不是不友善，是誠實：
螢幕誤差選階的整套品質保證建立在那個數字上，沒有它只能猜，而猜錯的兩個
方向（畫面糊掉／白花三角形）都不會報錯。

只傳一份 `BufferGeometry` 是完全合法的預設路徑 —— 那就沒有 LOD，
而且它會說出來。

---

### 螢幕誤差的分母是「這次畫到哪裡」，不是畫布多大

`renderer.getRenderTarget()` 有值就用它的高度。三種常見情況會讓兩者不同：
後處理（`EffectComposer` 的 render target）、陰影（shadow map）、離屏預覽。

用錯的症狀是**選到太細或太粗的階，而畫面看起來完全正確** —— 半解析度的
composer 會讓每個物件都白付三角形，2048² 的 shadow map 對 1080p 畫布差快兩倍。

### 陰影 pass 是**另一條路徑**，套件必須自己接

這裡原本寫著「`onBeforeShadow` 不必特別處理：`BatchedMesh` 會轉呼叫
`onBeforeRender`，相機與尺寸自然都是對的」。**那是錯的，而且從來沒有量過。**

`WebGLShadowMap` 直接呼叫 `renderBufferDirect`，`onBeforeRender` 一次都不會被
呼叫；Three 的 `onBeforeShadow` 預設是空的。所以陰影圖畫的是**上一次主相機**
留下來的繪製清單 —— 相機看不到的投影者，影子就消失了。

`WW.InstancedMesh` 因此自己覆寫 `onBeforeShadow`，用光源的視錐與投影重新
收集一次。三件事與主畫面不同：

| | 主畫面 | 陰影 pass |
| --- | --- | --- |
| 視錐 | 相機的 | **光源的** |
| 誤差上限 | `errorPixels`（預設 2） | **`shadowErrorPixels`（預設三倍）** |
| 遮蔽剔除 | 套用 | **不套用** |

遮蔽剔除不套用的理由與視錐同一個：遮蔽緩衝是從主相機畫出來的，它說的是
「相機看不到」。看不到不等於不投影。

誤差上限放寬的理由是陰影被投影、被過濾、被半影糊過一次 —— 投影者的輪廓
差幾個像素，在陰影上看不出來。實測 3,000 個 instance 放寬三倍：陰影 pass
的三角形 1,500,000 → 540,000。要關掉整套行為用 `shadowCulling: false`，
那就退回 Three 原本的樣子（留這個開關是為了 A/B，不是因為關掉有好處）。

順帶：陰影相機是**正交**的，而正交投影下選階不能除以距離（同一個東西不管
多遠都佔一樣多的像素）。這條式子在逐一選階與遠景合併兩個地方都要一致 ——
只改一個的症狀是「每個 instance 算出來要用第 3 階，整格卻被合併成最粗階」。

### 反射探針借輻照度探針的格子，不自己開一份

```js
const probes = new WW.IrradianceVolume({ min, size, resolution: [8, 4, 8] });
const reflections = new WW.ReflectionProbes(probes);
// 每幀：一次拍攝，兩個產物
await WW.bakeIrradiance(renderer, scene, probes, { reflection: reflections });
```

烘一顆探針最貴的一段是等 GPU 把 cubemap 讀回來（一顆 2.7 ms，其中「畫六次」
只佔 0.3 ms）。同一批面像素投影成 SH 給間接光、重取樣成八面體給反射 ——
分兩次拍是兩倍的成本，換不到任何東西。

代價是反射探針不能有自己的密度。這是刻意的，而且傳錯體積會直接丟例外
（位置分兩份記的症狀是「反射裡的世界比間接光偏了半格」，不會報錯）。

### 烘好的東西要知道世界變了：`onCellChanged`

```js
WW.worldFor(scene).stream({
  cellSize: 200,
  radius: 700,
  load: (cx, cz, place) => { … },
  onCellChanged: ({ centerX, centerZ, radius }) => {
    probes.invalidateAround(new THREE.Vector3(centerX, 0, centerZ), radius);
  },
});
```

探針、距離場、導航網格都是在**內容之前**就擺好的。世界還沒串流進來時那一區
拍到的是空的，而它會一直是空的 —— 烘過的不會再烘。

症狀是「這一區的反射裡少了一棟樓」「這個山谷不會變暗」，而畫面不會報錯、
幀時間也完全正常。這是串流世界最典型的靜默錯誤。

收回呼而不是直接收一個探針體積：串流不該知道有探針這種東西，而「要失效什麼」
那份清單只有呼叫端知道。

### 水分成兩件事，而外觀那一半也在套件裡

```js
const water = new WW.Water({ level: 0 });          // 水面多高 —— 浮力要的
const surface = new WW.WaterSurface({ water });    // 看起來像水 —— 同一個 water
surface.setProbes(reflectionProbes);

const mesh = new THREE.Mesh(new THREE.PlaneGeometry(400, 400, 256, 256), surface.material);
mesh.rotation.x = -Math.PI / 2;
scene.add(mesh);

// 每幀，畫之前：
surface.setTime(elapsed);
surface.capture(renderer, scene, camera, mesh);    // 拍水**以外**的場景
renderer.render(scene, camera);
```

這裡原本的界線是「外觀是開發者的材質，套件不碰」。那條界線畫錯了：外觀幾乎
全部是從套件已經算出來的東西推出來的 —— 水深來自場景深度、反射來自反射探針、
波峰的形狀來自 `Water` 自己。

交給開發者寫的話他要**重新寫一份波形**，而那正是 `Water` 存在要防的事：兩份
對不起來時船會浮在錯的高度，不會報錯。現在位移那段 GLSL 就是
`water.displacementGLSL()` 的同一個字串，實測畫出來的水面與 `heightAt` 差
0.024 公尺。

`capture` 要排除水面本身。忘了排除的話折射會取樣到水自己，症狀是水面上出現
一層越疊越糊的鏡像。

**畫的時候拿 `materialFor(renderer)`，改參數走 `setParams`。**

```js
mesh.material = surface.materialFor(renderer);      // 每幀。WebGPU 上是另一份材質
surface.setParams({ refraction: 0.12 });            // 不要去戳 material.uniforms
```

`material` 是 WebGL 那一份。`WebGPURenderer` 收到 `ShaderMaterial` 會直接丟
「Material "ShaderMaterial" is not compatible」，所以 WebGPU 上真正在畫的是
非同步建起來的 node 材質 —— 還沒建好時 `materialFor` 回 `null`，意思是
「這一幀先別畫水」。換材質很便宜，每幀換一次比記錄狀態可靠。

同理，改 `material.uniforms` 只會改到 WebGL 那份，而症狀是「這個參數在 WebGPU
上沒反應」—— 看起來像效果本身壞了。跨後端關卡現在守著這件事：折射推大六倍，
兩邊的顏色都要真的動。

---

## 十一、還沒決定的事

刻意留白，不編造：

- **`dispose()`** 的形狀（`BatchedMesh.dispose()` 目前直接繼承）
- **多個 scene** 共存時，串流與預算是各自獨立還是共用
- **`WW.Mesh` / `WW.Group`**：非 instanced 的內容要不要有對應版本
- **`instanceColor`**：`setColorAt` 可用（繼承自 `BatchedMesh`），但沒有對應
  `THREE.InstancedMesh.instanceColor` 的檢視
- **TypeScript 型別**暴露到什麼程度（太多會逼使用者理解內部）
