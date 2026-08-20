import * as THREE from 'three';
import * as WW from '@webworld/three';
import { readPixelsAsync } from './readback.ts';

/**
 * 距離場陰影的證明場景：一個**大**箱子在一片空地上。
 *
 * ## 為什麼要大、要遠
 *
 * 距離場陰影補的是 shadow map 在遠處撐不住的那一段，而場本身是低頻的
 * （一格 `extent / resolution`）。小東西在場裡幾乎不存在，所以拿小東西驗
 * 只會量到「什麼都沒發生」——而那不是實作的錯。
 *
 * 箱子 16 單位、場一格 3.1 單位，所以它橫跨約五格。
 *
 * ## 判準
 *
 * 影子落在背光那一側，長度算得出來：箱高 30、光的仰角約 31 度，所以影子
 * 大約 50 單位長。於是 −30 那一點該在影子裡，−90 那一點該在影子外。
 *
 * 兩個點都要驗 —— 只驗「有變暗」的話，一個「整片都暗」的 bug 也會通過。
 */

// 16 單位、場一格 3.1 —— 橫跨五格，場表示得出來。
// 影子長度 = 16 / tan(54°) ≈ 12，到 x = −20 為止，所以「影子外但場內」有位置放點。
const BOX = 16;
const FIELD_EXTENT = 150;
const FIELD_RESOLUTION = 48;

export interface DfShadowScene {
  root: THREE.Group;
  camera: THREE.PerspectiveCamera;
  /** 把場算到完整。回傳跑了幾輪。 */
  settle: () => number;
  render: (renderer: THREE.WebGLRenderer) => void;
  sample: (renderer: THREE.WebGLRenderer, point: THREE.Vector3) => number;
  /** 同一件事，非同步 —— WebGPU 沒有同步的讀回。 */
  sampleWindowAsync: (renderer: unknown, point: THREE.Vector3, size: number) => Promise<number>;
  /** 整張遮罩有多少比例是暗的，兩個後端都走得通。 */
  coverageAsync: (renderer: unknown) => Promise<number>;
  /** 等 WebGPU 那條路建好。 */
  nodeReady: (renderer: unknown) => Promise<void>;
  coverage: (renderer: THREE.WebGLRenderer) => number;
  points: {
    shadow: THREE.Vector3;
    open: THREE.Vector3;
    behind: THREE.Vector3;
    outside: THREE.Vector3;
    boxTop: THREE.Vector3;
    terminator: THREE.Vector3;
  };
  /**
   * 換一個相機角度。
   *
   * 法線如果沒有從視空間換回世界，「這一面朝不朝著光」的判斷會跟著相機
   * 轉 —— 而靜止的相機看不出來（錯的方向也是固定的錯）。
   */
  setCameraAngle: (which: 0 | 1) => void;
  /**
   * 畫一次體積霧。`useField` 決定光柱會不會被擋住 —— 那正是這件事的重點。
   */
  renderFog: (renderer: THREE.WebGLRenderer, useField: boolean) => void;
  /** 讀霧貼圖上某個世界座標投影到的那一點：RGB 是散射光，A 是透光率。 */
  sampleFog: (
    renderer: THREE.WebGLRenderer,
    point: THREE.Vector3,
  ) => [number, number, number, number];
  setStrength: (value: number) => void;
  fieldPending: () => number;
}

function targetOf(shadows: WW.DistanceFieldShadows): THREE.WebGLRenderTarget {
  return (shadows as unknown as { target: THREE.WebGLRenderTarget }).target;
}

export function makeDfShadowScene(): DfShadowScene {
  const root = new THREE.Group();

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: 0xa8a8a8, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  root.add(ground);

  const boxGeometry = new THREE.BoxGeometry(BOX, BOX, BOX);
  const box = new THREE.Mesh(boxGeometry, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }));
  box.position.set(0, BOX / 2, 0);
  box.updateMatrixWorld(true);
  root.add(box);

  // ## 一顆球：法線要有**每一種**朝向
  //
  // 平面與箱子只有六種法線，而「法線沒從視空間換回世界」那個 bug 在那六種
  // 上剛好都不改變結果（朝光與否兩邊判一樣）。球面上什麼角度都有，一定有
  // 一批像素的判斷會翻掉 —— 而那批像素只有看整張的暗掉比例才數得到。
  const sphereGeometry = new THREE.SphereGeometry(9, 48, 32);
  const sphere = new THREE.Mesh(sphereGeometry, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }));
  // 擺遠一點：球自己的影子不可以壓到對照點上（第一版壓到了，於是「側面應該
  // 是亮的」那條紅了 —— 而那是場景擺錯，不是效果錯）。
  sphere.position.set(-4, 9, 55);
  sphere.updateMatrixWorld(true);
  root.add(sphere);

  const sun = new THREE.DirectionalLight(0xffffff, 3);
  // 仰角 54 度：箱高 30 除以 tan(54°) ≈ 22，影子到 x = −37 為止。場只有 ±75，
  // 影子太長的話「影子外但場內」就沒有位置放取樣點了。
  sun.position.set(100, 140, 0);
  root.add(sun);
  const lightDirection = new THREE.Vector3(0, 0, 0).sub(sun.position).normalize();

  // 場裡放的是**同一份幾何**，位置也一樣 —— 場與畫面對不上的話陰影會整個
  // 偏掉，而那看起來像實作壞了。
  const volume = new WW.DistanceFieldVolume(boxGeometry, { resolution: 32, padding: 0.3 });
  const field = new WW.GlobalDistanceField({ resolution: FIELD_RESOLUTION, extent: FIELD_EXTENT, budget: 200000 });
  field.add({ volume, matrixWorld: box.matrixWorld });
  const sphereVolume = new WW.DistanceFieldVolume(sphereGeometry, { resolution: 32, padding: 0.3 });
  field.add({ volume: sphereVolume, matrixWorld: sphere.matrixWorld });

  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 900);
  camera.position.set(-70, 55, 95);
  camera.lookAt(-25, 0, 0);
  camera.updateMatrixWorld(true);

  const gbuffer = new WW.SceneDepthNormals({ scale: 1 });
  const shadows = new WW.DistanceFieldShadows({ steps: 64, softness: 6, strength: 1 });
  const fog = new WW.VolumetricFog({
    density: 0.06,
    steps: 48,
    range: 220,
    anisotropy: 0.7,
    shadowSteps: 24,
  });

  const scene = new THREE.Scene();
  scene.add(root);

  const pixel = new Uint8Array(4);
  const projected = new THREE.Vector3();
  const fieldCentre = new THREE.Vector3(0, 0, 0);

  /** 一幀：更新深度法線，然後算距離場陰影。`nodeReady` 也要用它。 */
  const drawOnce = (renderer: THREE.WebGLRenderer): void => {
    gbuffer.update(renderer, scene, camera);
    shadows.render(renderer, camera, gbuffer, field, lightDirection);
  };

  return {
    root,
    camera,
    settle: () => {
      let rounds = 0;
      while (field.pendingCells > 0 && rounds < 200) {
        field.update(fieldCentre);
        rounds++;
      }
      return rounds;
    },
    fieldPending: () => field.pendingCells,
    render: drawOnce,
    renderFog: (renderer, useField) => {
      gbuffer.update(renderer, scene, camera);
      fog.render(renderer, camera, gbuffer, lightDirection, new THREE.Color(0xffffff), useField ? field : null);
    },
    sampleFog: (renderer, point) => {
      const target = (fog as unknown as { target: THREE.WebGLRenderTarget }).target;
      projected.copy(point).project(camera);
      if (projected.x < -1 || projected.x > 1 || projected.y < -1 || projected.y > 1 || projected.z > 1) {
        return [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
      }
      const x = Math.round(((projected.x + 1) / 2) * target.width);
      const y = Math.round(((projected.y + 1) / 2) * target.height);
      const half = new Uint16Array(4);
      renderer.readRenderTargetPixels(
        target,
        Math.min(target.width - 1, Math.max(0, x)),
        Math.min(target.height - 1, Math.max(0, y)),
        1,
        1,
        half,
      );
      return [
        THREE.DataUtils.fromHalfFloat(half[0] ?? 0),
        THREE.DataUtils.fromHalfFloat(half[1] ?? 0),
        THREE.DataUtils.fromHalfFloat(half[2] ?? 0),
        THREE.DataUtils.fromHalfFloat(half[3] ?? 0),
      ];
    },
    sampleWindowAsync: async (renderer, point, size) => {
      const target = targetOf(shadows);
      projected.copy(point).project(camera);
      const half = size >> 1;
      const x = Math.min(
        target.width - size,
        Math.max(0, Math.round(((projected.x + 1) / 2) * target.width) - half),
      );
      const y = Math.min(
        target.height - size,
        Math.max(0, Math.round(((projected.y + 1) / 2) * target.height) - half),
      );
      const data = await readPixelsAsync(renderer, target, x, y, size, size, (n) => new Uint8Array(n));
      let sum = 0;
      for (let i = 0; i < size * size; i++) sum += data[i * 4] ?? 0;
      return sum / (size * size) / 255;
    },
    coverageAsync: async (renderer) => {
      const target = targetOf(shadows);
      const data = await readPixelsAsync(renderer, target, 0, 0, target.width, target.height, (n) => new Uint8Array(n));
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if ((data[i] ?? 255) < 230) dark++;
      return dark / (target.width * target.height);
    },
    nodeReady: async (renderer) => {
      // node 材質是動態 import 進來的 —— 要等**真的時間**，microtask 不夠。
      for (let i = 0; i < 60; i++) {
        drawOnce(renderer as THREE.WebGLRenderer);
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    },
    sample: (renderer, point) => {
      const target = targetOf(shadows);
      projected.copy(point).project(camera);
      // ## 跑出畫面要回 NaN，不要夾到邊緣
      //
      // 夾住的話讀到的是畫面邊緣那一格（多半是天空，也就是 1.0），而
      // 「1.0」剛好長得像「這裡沒有陰影」——於是斷言綠得理直氣壯。
      //
      // 實測踩過：一個場外的取樣點根本不在畫面上，而它讓「越界回 0」那個
      // 破壞完全驗不到。
      if (projected.x < -1 || projected.x > 1 || projected.y < -1 || projected.y > 1 || projected.z > 1) {
        return Number.NaN;
      }
      const x = Math.round(((projected.x + 1) / 2) * target.width);
      const y = Math.round(((projected.y + 1) / 2) * target.height);
      renderer.readRenderTargetPixels(
        target,
        Math.min(target.width - 1, Math.max(0, x)),
        Math.min(target.height - 1, Math.max(0, y)),
        1,
        1,
        pixel,
      );
      return (pixel[0] ?? 0) / 255;
    },
    coverage: (renderer) => {
      const target = targetOf(shadows);
      const buffer = new Uint8Array(target.width * target.height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, buffer);
      let dark = 0;
      for (let i = 0; i < buffer.length; i += 4) {
        if ((buffer[i] ?? 255) < 230) dark++;
      }
      return dark / (target.width * target.height);
    },
    points: {
      // 影子裡：箱子背光側 30 單位，影子大約 50 單位長。
      shadow: new THREE.Vector3(-13, 0.1, 0),
      // 影子外：同一條線上但遠超過影子的長度。
      open: new THREE.Vector3(-48, 0.1, 0),
      // 側面：與光垂直的方向，箱子擋不到。
      behind: new THREE.Vector3(-13, 0.1, 25),
      // ## 場**外面**的地面
      //
      // 場只有 300 單位寬（±150），這一點在它外面。場外面代表**沒有資料**，
      // 不代表那裡有東西 —— 查詢越界時回 0 的話，整個場外面會變全黑。
      //
      // 而那個 bug 在場內的取樣點上完全看不到，所以非有這一點不可。
      outside: new THREE.Vector3(-105, 0.1, 0),
      // ## 箱子**自己**的受光面
      //
      // 地面不在距離場裡（場裡只有箱子），所以從地面出發的射線一開始就離
      // 表面很遠 —— 起點偏移拿掉也不會出事。**在場裡的表面**才驗得到那條。
      //
      // 箱頂朝上、太陽在上面，所以它應該是亮的。少了沿法線的偏移，起點就在
      // 場的表面上（距離≈0），第一步就判定全影 —— 箱頂會變全黑。
      boxTop: new THREE.Vector3(0, BOX + 0.05, 0),
      // ## 球面上接近明暗交界的地方
      //
      // 那裡「這一面朝不朝著光」剛好在邊緣上，所以法線只要偏一點，判斷就翻。
      // 而法線沒從視空間換回世界的話，它偏多少**取決於相機** —— 於是同一個
      // 世界座標在兩個相機角度下會得到不同的答案。
      //
      // 這是唯一驗得到那條的地方：平面與箱子的六種法線兩邊剛好判一樣，而整張
      // 的暗掉比例只差 0.36 個百分點（14.32% 對 13.96%），訂不出安全的門檻。
      terminator: new THREE.Vector3(-4 - 6.75, 9 + 5.94, 55),
    },
    setCameraAngle: (which) => {
      if (which === 0) camera.position.set(-70, 55, 95);
      // 低角度：地面的**視空間**法線與第一個角度差很多。兩個角度都是
      // 俯視的話，法線沒換回世界那個 bug 兩邊會犯一樣的錯，於是驗不到。
      else camera.position.set(-120, 14, -30);
      camera.lookAt(-30, 4, 0);
      camera.updateMatrixWorld(true);
    },
    setStrength: (value) => {
      (shadows as unknown as { options: { strength: number } }).options.strength = value;
    },
  };
}
