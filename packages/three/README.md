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
