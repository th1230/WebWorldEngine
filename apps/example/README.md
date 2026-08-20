# 範例 app

一個普通的 Three.js 專案。整支 [`src/main.ts`](src/main.ts) 裡只有一處與
本套件有關。

```bash
pnpm example
```

## 主場景

| 網址 | 說明 |
| --- | --- |
| <http://localhost:5174/> | `WW.InstancedMesh` |
| <http://localhost:5174/?ww=0> | `THREE.InstancedMesh`，其餘不改 |
| <http://localhost:5174/?count=200000> | 更改實例數 |
| <http://localhost:5174/?post=1> | 加上後處理（`EffectComposer` + bloom） |
| <http://localhost:5174/?shadows=1> | 加上陰影（2048² shadow map） |
| <http://localhost:5174/?autolod=1> | 不自備 LOD 鏈，由套件在 worker 中產生 |
| <http://localhost:5174/?cooked=1> | 載入 cook 過的資產（先執行 `pnpm cook`） |
| <http://localhost:5174/?stream=1> | 開啟串流：內容隨相機載入與卸載 |

它要證明的是：

- `WW.InstancedMesh` 是一個 `Object3D`，`scene.add()` 後即開始運作
- 沒有初始化、`update()` 或自訂的 render loop
- 場景中的 `walker`、`ground`、`fog` 與燈光全部是原生 Three.js
- 換回 `THREE.InstancedMesh` 後程式照常執行，只是沒有 LOD 與剔除
- `EffectComposer` 與 shadow map 照常運作 —— 套件沒有為這兩條路徑寫任何
  程式碼，`onBeforeShadow` 會轉呼叫 `onBeforeRender`

### `?autolod=1`

改用未經處理的 `IcosahedronGeometry(1, 24)`（12,500 個三角形、非索引）且
不傳入 `lods`，由套件在 worker 中補上 LOD 鏈。

HUD 分開列出兩個數字：

```text
LOD 產生       39.7 ms (worker)
  主執行緒付了  2.1 ms（複製 + 接回批次幾何）
```

分開列是必要的：「在 worker 裡執行」缺少主執行緒那一項就只是一個宣稱。
第三行的「頁面最長空窗」量的是整個頁面（含模組載入、擺放矩陣、首次繪製），
是上界而非 LOD 的成本。

### `?cooked=1`

三種來源產生同一個形狀：

```js
new WW.InstancedMesh(geometry, material, n);                     // 自動產生
new WW.InstancedMesh({ lods, errors }, material, n);             // 自備
new WW.InstancedMesh(await WW.load(manifest, id), material, n);  // cook 過的
```

`/cooked/*` 由 `vite.config.ts` 的一段 middleware 直接讀 benchmark app 的
輸出目錄。複製一份過來會使兩邊逐漸不一致，而「資產是舊的」在畫面上看起來
與「效果沒生效」相同。

HUD 上不會出現「LOD 產生」，因為 cook 過的路徑 runtime 不做任何簡化
（`lodStats` 為 `null`）。

### 陰影的驗證方式

未被畫進 shadow map 不會產生錯誤，畫面只是少了影子。驗證方式是關閉
`castShadow` 後再比一次：

```js
__ww.rocks.castShadow = false; __ww.step(2);
```

畫面若有變化（實測 0.8% 的像素）即代表實例確實進入了 shadow map。

## 效果場景

每個效果各有一個獨立場景，以網址參數開啟。

| 網址 | 內容 | 對應關卡 |
| --- | --- | --- |
| `?contact=1` | 接觸陰影 | `pnpm contact-check` |
| `?dfshadow=1` | 距離場陰影與體積霧 | `pnpm df-shadow-check` |
| `?fog=1` | 體積霧的光柱與遮蔽 | `pnpm fog-check` |
| `?vsm=4` | 虛擬陰影圖（數字為虛擬解析度相對圖集的倍數） | `pnpm vsm-check` |
| `?reflect=1` | 追蹤反射：螢幕空間 → 距離場 | `pnpm reflect-check` |
| `?reflprobe=1` | 再接上反射探針 | `pnpm reflprobe-check` |
| `?gi=1` | 間接光探針與螢幕空間間接光 | `pnpm gi-check`、`ssgi-check` |
| `?sky=1` | 大氣散射與日夜循環 | `pnpm sky-check`、`daynight-check` |
| `?waterlook=1` | 水的外觀：吸收、折射、泡沫 | `pnpm water-look-check` |
| `?physics=1&orbit=260` | 地形、碰撞、浮力 | `pnpm physics-check` |
| `?vt=1` | 虛擬貼圖 | `pnpm vt-check` |
| `?shadowlod=1` | 陰影 pass 自行剔除與選階 | `pnpm shadow-lod-check` |
| `?lodfade=1` | 換階交叉淡入 | `pnpm lod-fade-check` |
| `?trees=20000` | Impostor 對真幾何 | `pnpm impostor-check` |

這些場景是量測台，不是展示。相機位置、物件擺法與參數都是為了讓某一個判準
量得準而選的 —— 例如深度法線圖在此一律使用全解析度
（`world.setDepthNormals({ scale: 1 })`），因為重取樣的誤差會混進每一個
門檻。實際應用應使用預設的半解析度。

修改前先看對應的關卡：那些數值是綁在一起的。

### WebGPU

同樣的場景在 `/webgpu.html` 上以 `WebGPURenderer` 執行，參數相同。
`pnpm cross-check` 逐項比對兩個後端的輸出。

### 畫面比對的變因

以下四個參數是 `pnpm visual-check` 需要控制的變因，修改會使該檢查的基準
失效。

| 參數 | 用途 |
| --- | --- |
| `size` / `spread` / `orbit` | 讓物件在螢幕上夠大。預設的物件只有幾個像素、本來就全部落在最粗階，選階算錯不會改變畫面，比對因此驗不到東西 |
| `hlodBudgetMB` | 給足槽位。預設預算下這份內容只有 60 個槽位而有 443 組待合併，於是每一幀被合併的是不同的格子，畫面逐幀變動 |
| `verify=1` | 開啟 `preserveDrawingBuffer`，僅驗證時使用 |

畫面左上角顯示可見數、逐一測試數、可見 cell 數與各 LOD 階的分佈。剔除
「沒生效」與「生效了但場景本來就全在畫面內」在幀率上沒有差別，需要這些
數字才能區分。

## 品質契約的驗證

LOD 的契約是幾何誤差投影至螢幕不超過 2 像素。在 console 中：

```js
await __ww.verifyQuality()
```

它以一個真正的 `THREE.InstancedMesh`（最細的幾何、不剔除、不選階）繪製
參考影像，然後檢查強化版的每個像素能否在參考影像的 ±2 像素鄰域內找到
相符的顏色。

逐像素相等不是可用的判準：輪廓平移一個像素造成的抗鋸齒差異會淹沒其他
訊號，該檢查隨後會被忽略。

判讀依據是 `meanGradientAtOutside` 與 `meanGradientOverall` 的比值：遠大於
1 代表差異集中在輪廓上（契約允許的位移），而非整片區域的著色改變。

## `window.__ww`

分頁不在前景時瀏覽器不派送 `requestAnimationFrame`，無頭驗證無法依賴動畫
迴圈，必須能從外部推進單一幀。

這也是「畫進使用者的 scene、不自行 render」這個決定的附帶效果：取得
`renderer` 即可完整重現一幀。
