# @webworld/cook

把 glTF 烘焙成 [`@webworld/three`](https://www.npmjs.com/package/@webworld/three)
吃的格式：LOD 鏈、MikkTSpace 切線、BC 壓縮貼圖。

```bash
npm i -D @webworld/cook
npx ww-cook ./assets --out ./public/cooked
```

```js
const rock = await WW.load('/cooked/assets.manifest.json', 'mesh:rock');
scene.add(new WW.InstancedMesh(rock, material, 10000));
```

## cook 是選配的加速，不是門檻

不 cook 也能用 —— `@webworld/three` 會在 worker 裡自動產生 LOD 鏈，鏈的
形狀跟這裡產出的**完全一樣**（預設參數是對齊的）。差別在成本：

| | cook 過的 | 執行期自動產生 |
| --- | --- | --- |
| 產生成本 | **0 ms** | 每個網格數十毫秒（在 worker 裡） |
| 索引 | 頂點數 < 65536 時是 **16-bit** | 32-bit |
| 額外下載 | `.wwm` | meshoptimizer 約 44 kB |

所以先不用 cook 也完全可以開始；等到啟動時間或下載量變成問題再加進 build。

## 用法

```text
ww-cook <來源目錄> [選項]

  --out <目錄>   輸出目錄（預設 ./public/cooked）
  --verify       烘焙兩次並比對雜湊，驗證可重現性
  --builtins     一併產生內建的程序化資產（量測用的固定物）
```

來源目錄裡的每個 `.glb` / `.gltf` 都會被烘焙。**每個 primitive 各自成為一個
mesh 資產** —— 繪製單位本來就是 primitive，不同材質必然是不同 draw。

分離形式的 `.gltf` 會自動帶上它引用的 `.bin` 與貼圖。

## 輸出

```text
public/cooked/
  assets.manifest.json    每個資產的區塊位置、LOD 誤差、包圍球
  mesh_*.wwm              頂點與各階索引
  texture_*.ktx2          BC 壓縮貼圖
```

`.wwm` **不是自描述的** —— 各 LOD 的區塊位置記在 manifest 裡，不重複記在
檔頭（兩份真相遲早會不一致）。所以 `WW.load()` 要 manifest 與資產 id 兩個參數。

## 可重現

同一批輸入必須得到同一個雜湊 —— 否則兩台機器 cook 出來的東西不同，快取
就永遠是髒的。`--verify` 在同一個行程內烘焙兩次並比對，任何隱藏的狀態
相依都會現形。

檔案的掃描順序有排序，因為 `readdirSync` 的順序在不同檔案系統上不保證一致。

## 匯入器丟掉的東西會講出來

骨骼、morph target、頂點色目前不支援。它們不會靜默消失 —— manifest 的
`warnings` 會列出來，CLI 也會印。

**「烘焙成功、零警告」而東西其實被丟掉了**，是這類工具最常見的失效形態。

## 相容性

`@webworld/cook` 與 `@webworld/three` 透過 [`@webworld/format`](https://www.npmjs.com/package/@webworld/format)
共用格式定義。兩者解析到的 `@webworld/format` 必須是同一個 major ——
版本分岔的症狀是「cook 完載不進去」，而錯誤訊息會指向 schema 版本。

## 範圍

貼圖只產生 **BC 系列**（桌機）。行動裝置的 ETC2／ASTC 不在範圍內 ——
沒有任何桌機能解碼它們，寫出來的編碼器只能用自己的解碼器驗，證明不了任何事。

Node.js ≥ 22.12。`sharp` 有平台專屬的原生 binary。

MIT
