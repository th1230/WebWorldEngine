# 變更紀錄

三個套件（`@web-world-engine/three`、`@web-world-engine/format`、`@web-world-engine/cook`）**齊步發布**，
版本永遠相同 —— 理由見 [`tools/release/version.mjs`](tools/release/version.mjs)。
所以有時候會有一個「這個套件什麼都沒改」的版本。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，
版號遵循 [語意化版本](https://semver.org/lang/zh-TW/)。

## [未發布]

目前 `package.json` 上是 `0.1.0`，而**還沒有發布過任何版本** —— 下面全部
都會落在第一個發出去的版本裡。「破壞性變更」是相對於 repo 上一個狀態說的，
對使用者來說還不存在。

### 破壞性變更

- **螢幕空間的效果統一成同一個形狀**：`render(renderer, scene, camera, options)`。
  受影響的是 `ContactShadows`、`DistanceFieldShadows`、`VolumetricFog`、
  `TracedReflections`、`ScreenSpaceGI`，以及改名的 `VirtualShadowMap.resolve`
  → `.render`。

  共用的深度法線圖不再由呼叫端建立與傳入 —— 效果自己去 `worldFor(scene)` 拿。
  每幀開頭要呼叫一次 `worldFor(scene).beginFrame()`。

  ```diff
  - const gbuffer = new WW.SceneDepthNormals({ scale: 1 });
    function frame() {
  -   gbuffer.update(renderer, scene, camera);
  -   contact.render(renderer, camera, gbuffer, lightDirection);
  +   WW.worldFor(scene).beginFrame();
  +   contact.render(renderer, scene, camera, { lightDirection });
    }
  ```

- `terrainHeightfield()` 改名為 `buildHeightfield()`，與 `buildTerrain()` 成對。

- 刪掉 `SceneDepthNormals.isFresh()`。有了 `beginFrame()` 之後「新不新」是
  確定的，那個 `<= 8` 幀的猜測沒有存在的理由。

### 新增

- `World.beginFrame()`：告訴套件新的一幀開始了，共用的中間結果一幀只算一次。
- `World.depthNormals(renderer, camera)`：拿那張共用的深度法線圖。
- `World.setDepthNormals(options)`：調它的解析度（預設半解析度）。
- `loadMaterial(url, id, { MaterialClass })`：WebGPU 上給 node 材質類別。
- `pnpm metadata-check`：守 npm 頁面上看得到的那些欄位。
- `pnpm bundle-check`：守「只用 WebGL 的人不該下載 WebGPU 那一半」。

### 改進

- `ScreenSpaceGI` 不再自己重畫一次深度法線，改用共用的那一張 —— 每幀少一次
  完整的場景繪製。
- `IrradianceVolume.intensity` 在 WebGPU 上真的會生效了。先前那個值掛在
  lighting context 底下的 uniform 上，而那一組**只在第一次繪製時上傳**，
  所以改了沒有作用而且沒有任何徵兆。

---

## 這個套件是什麼

`WW.InstancedMesh` 換掉 `THREE.InstancedMesh` 就有螢幕誤差 LOD 與空間分割
剔除；世界串流、遠景合併、間接光、陰影、反射、霧、水、地形、物理調度、
虛擬貼圖、虛擬陰影圖，WebGL2 與 WebGPU 兩條路。

完整清單見 [`packages/three/README.md`](packages/three/README.md)。
