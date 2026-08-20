# 範例：換一個字

一個**普通的 Three.js 專案**。整支 [`src/main.ts`](src/main.ts) 裡只有一處
跟這個套件有關。

```bash
pnpm example
```

| 網址 | 是什麼 |
| --- | --- |
| <http://localhost:5174/> | `WW.InstancedMesh` |
| <http://localhost:5174/?ww=0> | `THREE.InstancedMesh`，其餘一行不改 |
| <http://localhost:5174/?count=200000> | 換個數量 |
| <http://localhost:5174/?post=1> | 加上後處理（`EffectComposer` + bloom） |
| <http://localhost:5174/?shadows=1> | 加上陰影（2048² shadow map） |
| <http://localhost:5174/?autolod=1> | 不自備 LOD 鏈，讓套件在 worker 裡產生 |
| <http://localhost:5174/?cooked=1> | 載入 cook 過的資產（先跑 `pnpm cook`） |
| <http://localhost:5174/?stream=1> | 開串流：內容跟著相機載入卸載 |

## 每個效果各有一個場景

上面那一組是 `main.ts` —— 「換一個字」那件事。除此之外每一個效果各有
一個獨立場景，用網址參數開：

| 網址 | 看什麼 | 哪一道關卡吃它 |
| --- | --- | --- |
| `?contact=1` | 接觸陰影 | `pnpm contact-check` |
| `?dfshadow=1` | 距離場陰影與體積霧 | `pnpm df-shadow-check` |
| `?fog=1` | 體積霧的光柱與遮蔽 | `pnpm fog-check` |
| `?vsm=4` | 虛擬陰影圖（數字是虛擬解析度相對圖集的倍數） | `pnpm vsm-check` |
| `?reflect=1` | 追蹤反射：螢幕空間 → 距離場 | `pnpm reflect-check` |
| `?reflprobe=1` | 再接上反射探針 | `pnpm reflprobe-check` |
| `?gi=1` | 間接光探針與螢幕空間間接光 | `pnpm gi-check、ssgi-check` |
| `?sky=1` | 大氣散射與日夜循環 | `pnpm sky-check、daynight-check` |
| `?waterlook=1` | 水的外觀：吸收、折射、泡沫 | `pnpm water-look-check` |
| `?physics=1&orbit=260` | 地形、碰撞、浮力 | `pnpm physics-check` |
| `?vt=1` | 虛擬貼圖 | `pnpm vt-check` |
| `?shadowlod=1` | 陰影 pass 自己剔除、自己選階 | `pnpm shadow-lod-check` |
| `?lodfade=1` | 換階交叉淡入 | `pnpm lod-fade-check` |
| `?trees=20000` | Impostor 對真幾何 | `pnpm impostor-check` |

**這些場景是量測台，不是展示。** 它們的相機位置、物件擺法、參數全部是為了
讓某一個判準量得準而選的 —— 例如深度法線圖在這裡一律用全解析度
（`world.setDepthNormals({ scale: 1 })`），因為重取樣的誤差會混進每一個
門檻裡。真實應用該用預設的半解析度。

改動它們之前先看對應的關卡：那些數字是綁在一起的。

### WebGPU 那一條

同樣的場景在 `/webgpu.html` 上跑 `WebGPURenderer`，參數一樣。
`pnpm cross-check` 就是把兩邊逐項比對 —— 同一個效果、兩個後端，必須算出
同一組數字。

### 給 `pnpm visual-check` 用的四個

這四個不是展示用的，是**畫面比對需要控制的變因**。列在這裡是因為改了
它們會讓那個檢查的基準失效。

| 參數 | 為什麼存在 |
| --- | --- |
| `size` / `spread` / `orbit` | 讓物件在**螢幕上很大**。預設那組是兩萬個又遠又小的物件，每個只有幾個像素、本來就全部在最粗階 —— 選階算錯根本不動畫面，比對因此驗不到東西 |
| `hlodBudgetMB` | 給滿槽位。預設預算下這份內容只有 60 個槽位而有 443 組要合併，於是**每一幀被合併的是不同的那幾格**，畫面每幀都不同 |
| `verify=1` | 開 `preserveDrawingBuffer`。只在驗證時開 —— 真實網站不需要付那份成本 |

畫面左上角會顯示可見數、逐一測試數、可見 cell 數與各 LOD 階的分佈 ——
**沒有這些數字就沒辦法判斷剔除到底有沒有生效**，因為「沒生效」跟
「生效了但場景本來就全在畫面裡」在幀率上長得一模一樣。

## 它證明了什麼

- `WW.InstancedMesh` 是一個 `Object3D`：`scene.add()` 就開始運作
- 沒有初始化、沒有 `update()`、沒有自己的 render loop
- 場景裡的 `walker`、`ground`、`fog`、燈光全部是原生 Three.js，套件不碰
- 換回 `THREE.InstancedMesh` 程式照樣跑，只是沒有 LOD 與剔除
- **`EffectComposer` 與 shadow map 都照舊** —— 那兩條路徑套件一行程式碼都
  沒為它們寫，`onBeforeShadow` 會自己轉呼叫 `onBeforeRender`

### `?autolod=1`：手上只有一份密網格

那個模式改用一份**沒處理過的** `IcosahedronGeometry(1, 24)`（12,500 個
三角形、非索引），不傳 `lods` —— 套件會在 worker 裡把鏈補上。

HUD 會分開列兩個數字：

```text
LOD 產生       39.7 ms (worker)
  主執行緒付了  2.1 ms（複製 + 接回批次幾何）
```

**分開報是必要的。**「在 worker 裡跑」沒有主執行緒那一項撐著就只是一個
宣稱。第三行的「頁面最長空窗」量的是整個頁面（含模組載入、擺放兩萬個
矩陣、首次繪製），是上界，不是 LOD 的成本。

### `?cooked=1`：三條路，同一個形狀

```js
new WW.InstancedMesh(geometry, material, n);                     // 自動產生
new WW.InstancedMesh({ lods, errors }, material, n);             // 自備
new WW.InstancedMesh(await WW.load(manifest, id), material, n);  // cook 過的
```

`/cooked/*` 由 `vite.config.ts` 的一小段 middleware 直接從 benchmark app 的
輸出目錄讀 —— 複製一份過來的話兩邊遲早會不一致，而「資產是舊的」看起來
就只是「效果沒生效」。

HUD 上 `LOD 產生` 那一行不會出現，因為 cook 過的路徑 runtime 一次簡化
都不做（`lodStats` 是 null）。

### 陰影要驗的不是「有沒有報錯」

沒被畫進 shadow map 也不會報錯，畫面只是少了影子。所以驗的方式是把
`rocks.castShadow` 關掉再比一次：

```js
__ww.rocks.castShadow = false; __ww.step(2);
```

畫面有變（實測 0.8% 的像素）就代表 instance 真的進了 shadow map。

## 品質契約的實測

LOD 的契約是「幾何誤差投影到螢幕上 ≤ 2 像素」。在 console 裡：

```js
await __ww.verifyQuality()
```

它會用一個**真的 `THREE.InstancedMesh`**（最細的幾何、不剔除、不選階）
畫一張參考影像，然後問：強化版的每個像素，在參考影像的 ±2 像素鄰域裡
找不找得到相符的顏色。

逐像素相等是錯的判準 —— 輪廓平移到隔壁像素的抗鋸齒差異會淹沒一切，
然後這個檢查就會被忽略。

判讀方式看 `meanGradientAtOutside` 與 `meanGradientOverall` 的比值：
遠大於 1 代表差異都落在輪廓上（契約允許的位移），而不是整片區域的
著色變了。

## 為什麼有 `window.__ww`

分頁不在前景時瀏覽器不派送 `requestAnimationFrame`，無頭的驗證沒辦法靠
動畫迴圈 —— 必須能從外面自己推一幀。

這也是「畫進使用者的 scene、不自己 render」那個決定的附帶好處：拿到
`renderer` 就能完整重現一幀。
