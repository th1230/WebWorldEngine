# 變更紀錄

三個套件（`@web-world-engine/three`、`@web-world-engine/format`、
`@web-world-engine/cook`）**齊步發布**，版本永遠相同 —— 理由見
[`tools/release/version.mjs`](tools/release/version.mjs)。所以有時候會有一個
「這個套件什麼都沒改」的版本。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，
版號遵循 [語意化版本](https://semver.org/lang/zh-TW/)。

## [0.1.1] — 2026-08-20

僅文件變更。三個套件的程式碼與型別與 0.1.0 相同。

### 變更

- 四份 README 依大型 npm 套件的慣例重寫：badge、一句話定位、安裝、相容性表、
  目錄，之後每個 API 一節 —— 先說明用途與適用情境，再列簽名、參數表與限制。
  先前的版本沒有 API 描述。
- 參數表的預設值改為從建構式實際讀取的那一個取得，而非從註解抄。

### 修正

- `GlobalDistanceField` 的 `budget` 先前記為毫秒，實際單位是每幀重算的格數
  （預設 4096）。
- `DistanceFieldShadows` 的 `range` 先前記為「預設 0」。`0` 是哨兵值，代入的
  是 `field.extent * 0.5`。
- 遠景合併的 A/B 表引用了容量掃描的繪製次數（2,094）而非該次 A/B 的數字
  （1,830），場景規模也誤植為剔除後的可見數，實際是六萬個實例。
- 遮蔽剔除的說明把「代表性內容上剔除 0 個」寫成特定的兩萬個實例場景。

### 未變更

`@web-world-engine/format` 與 `@web-world-engine/cook` 的程式碼沒有變動。
三個套件齊步發布，版本永遠相同。

## [0.1.0] — 2026-08-20

第一版。

**你只需要裝一個**：`npm i @web-world-engine/three`。`format` 是它的相依，
npm 會自己帶進來；`cook` 是選配的離線工具，不裝也完全能用（LOD 鏈會在
worker 裡自動產生，形狀跟 cook 出來的一樣）。

### 換一個字

```diff
- const rocks = new THREE.InstancedMesh(geometry, material, 10000);
+ const rocks = new WW.InstancedMesh(geometry, material, 10000);
```

換來螢幕誤差 LOD 與空間分割剔除。沒有初始化、沒有 `update()`、沒有自己的
render loop —— 它是一個 `Object3D`，加進場景就開始運作。

### 這一版裡有的

| | |
| --- | --- |
| **放東西進世界** | `InstancedMesh`、`MultiMesh`、`splitWithLods`、`scatter`、遠景合併（HLOD）、遮蔽剔除、換階淡入、`ImpostorBatch`、`AnimatedInstancedMesh`（VAT）、`VirtualTexture` |
| **世界比記憶體大** | `worldFor(scene).stream()`、`OriginRebase` |
| **光** | CSM（`applyShadows`）、`VirtualShadowMap`、`ContactShadows`、`DistanceFieldShadows`、`IrradianceVolume`、`ScreenSpaceGI`、`ReflectionProbes`、`TracedReflections`、`VolumetricFog`、`GlobalDistanceField`、`SkyAtmosphere` |
| **地形、水、物理** | `buildTerrain` / `buildHeightfield`、`Water` / `WaterSurface` / `computeBuoyancy`、`PhysicsScheduler` |
| **資產** | `load` / `loadMaterial` / `loadTexture`，以及 `ww-cook` 這支 CLI |

每一項的實測數字與使用方式見
[`packages/three/README.md`](packages/three/README.md)。

### 兩個後端

WebGL2 與 WebGPU 都支援，同一份程式碼。每一個會往材質上加東西的功能都有
GLSL 與 TSL 兩份實作，而「兩份算出同一組數字」由 `pnpm cross-check` 逐項量。

WebGPU 上要接那幾個著色功能的話，材質必須是 node 材質：

```js
import { MeshStandardNodeMaterial } from 'three/webgpu';
const material = await WW.loadMaterial(url, id, { MaterialClass: MeshStandardNodeMaterial });
```

`three/tsl` 與 `three/webgpu` 是動態載入的 —— 只用 WebGL 的人不會下載那一半，
而那件事由 `pnpm bundle-check` 守著。

### 每幀的形狀

螢幕空間的那幾個效果共用同一張深度法線圖，所以每幀開頭要講一聲：

```js
const world = WW.worldFor(scene);

function frame() {
  world.beginFrame();
  const shadow = contact.render(renderer, scene, camera, { lightDirection });
  renderer.render(scene, camera);
}
```

漏了也不會壞，只是同一張圖一幀畫了好幾次 —— 套件會在主控台講一次。

### 已知的範圍

- **桌機瀏覽器。行動裝置不在範圍內** —— 不是「還沒做」，是無法驗證：
  ETC2／ASTC 沒有任何桌機能解碼，寫出來的編碼器只能用自己的解碼器驗，
  那證明不了任何事。
- **`three` 的 peer 鎖在一個 minor**（`>=0.185.0 <0.186.0`）。這個套件碰
  `THREE.BatchedMesh` 的私有欄位，因為官方沒有公開的替代路徑；而那 25 道拿
  原生 Three 當對照組的關卡只跑過那一個版本。結構改了會在建構時大聲報錯，
  鎖擋的是「名字與型別都沒變、意思變了」那一種。Three 出新版時 Dependabot
  會開 PR，跑過 `pnpm verify:all` 之後才放寬。
- **純 ESM。** CommonJS 的使用者要用動態 import。
