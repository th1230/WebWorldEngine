import * as THREE from 'three';
import * as WW from '@webworld/three';

/**
 * 天空的證明場景。
 *
 * ## 判準都是「顏色是積分出來的，不是調出來的」
 *
 * - 太陽高的時候天頂是**藍的**
 * - 太陽貼地平線的時候，朝著太陽那一面是**紅的**
 * - 地平線下是暗的（地球擋住了）
 *
 * 這三件事在散射模型裡都不是常數，是 Rayleigh 係數（藍光散得比紅光多）加上
 * 「陽光穿過的大氣有多厚」積出來的。改一個顏色常數是做不出來的。
 *
 * ## 而最重要的一條是它與間接光的接線
 *
 * 天空是 `scene.background`，而探針是**渲染場景**烘出來的 —— 所以探針會自動
 * 把天空吃進去。日落時天空是紅的，白色地面上的間接光就該是紅的。
 *
 * 那個紅在這個場景裡只有一個來源（所有東西都是白的），與 GI 那條
 * 「背光面偏紅，而紅只可能來自紅牆」是同一個判準形狀。
 */

export interface SkyScene {
  root: THREE.Group;
  /** 把太陽移到某個高度角（0 = 地平線，1 = 天頂附近），並重烘天空。 */
  setSun: (elevation: number, renderer: THREE.WebGLRenderer) => boolean;
  /** 讀 cube 某一面正中央的顏色。0:+X 1:−X 2:+Y 3:−Y 4:+Z 5:−Z。 */
  sampleFace: (renderer: THREE.WebGLRenderer, face: number) => [number, number, number];
  /**
   * 同一件事，但走非同步的讀回 —— 兩個後端都有這一支。
   *
   * WebGPU 沒有同步的 `readRenderTargetPixels`。要比對兩個後端就得有一支
   * 兩邊都走得通的，否則「量不到」會被誤讀成「畫錯了」。
   */
  sampleFaceAsync: (renderer: unknown, face: number) => Promise<[number, number, number]>;
  /**
   * 等 WebGPU 那條路建好，並把背景換成它那一張 cubemap。
   *
   * WebGL 上立刻返回。`scene.background` 一開始指到的是 WebGL 那張（建構
   * 的當下 node 那份還不存在），不換的話 WebGPU 上的背景是空的。
   */
  nodeReady: (renderer: unknown) => Promise<void>;
  /** 重烘了幾次。 */
  bakes: () => number;
  /** 把探針烘完，回傳烘了幾顆。天空已經是背景，所以探針會吃到它。 */
  bakeProbes: (renderer: THREE.WebGLRenderer) => Promise<number>;
  /** 白色地面上某一點的間接光。 */
  probeAt: (point: [number, number, number]) => [number, number, number];
  scene: THREE.Scene;
}

export function makeSkyScene(): SkyScene {
  const root = new THREE.Group();
  const scene = new THREE.Scene();
  scene.add(root);

  // 全白的場景：任何顏色都只可能來自天空。
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  root.add(ground);

  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(0, 100, 0);
  root.add(sun);

  const sky = new WW.SkyAtmosphere({ resolution: 64, intensity: 22 });
  scene.background = sky.texture;

  const probes = new WW.IrradianceVolume({
    min: new THREE.Vector3(-30, 0, -30),
    size: new THREE.Vector3(60, 20, 60),
    resolution: [4, 3, 4],
    intensity: 1,
  });

  const direction = new THREE.Vector3();
  const pixel = new Uint16Array(4);

  return {
    root,
    scene,
    setSun: (elevation, renderer) => {
      // 高度角 0 = 貼著地平線，1 = 接近天頂，**負的就是地平線下**。
      //
      // 太陽下山之後才驗得到「陽光被地球擋住了」那條 —— 太陽在地平線上時，
      // 往太陽的那條射線永遠不會鑽進地面，所以那個檢查根本不會觸發。
      const angle = elevation * (Math.PI / 2) * 0.98 + (elevation >= 0 ? 0.01 : -0.01);
      direction.set(Math.cos(angle), Math.sin(angle), 0).normalize();
      sun.position.copy(direction).multiplyScalar(150);
      sun.updateMatrixWorld(true);
      // 太陽下山時直接光也該變弱 —— 不然只有天空變紅、地面還是白得刺眼。
      sun.intensity = 2 * Math.max(0, Math.sin(angle));
      const rebaked = sky.update(renderer, direction);
      // 天空換了，探針全部過期。
      const centre = probes.min.clone().addScaledVector(probes.size, 0.5);
      probes.invalidateAround(centre, probes.size.length());
      return rebaked;
    },
    sampleFaceAsync: async (renderer, face) => {
      const target = sky.activeTarget;
      const size = target.width;
      // ## 讀**整面的平均**，不是正中心那一格
      //
      // 兩個後端的 cube 面是 X 鏡像的（套件裡的 `projectCubeToSH` 早就有一個
      // `flip` 參數就是為了它）。而 64 寬的面「正中心」落在第 31 與 32 格
      // 之間 —— 鏡像之後兩邊讀到的方向差半格，在天空的漸層上量出 2–4% 的
      // 差，看起來像實作不一致。
      //
      // 平均不受鏡像影響，也不受那半格影響。要比的是「這一面看到的天空」，
      // 而那本來就是一個面的量而不是一個點的量。
      // ## 兩個後端的讀回**簽章不一樣**
      //
      // WebGL：第 6 個參數是要填的緩衝區，第 7 個是 cube 的面。
      // WebGPU：第 6 個是 textureIndex、第 7 個才是面，而資料是**回傳**的。
      //
      // 把緩衝區丟給 WebGPU 的話它會拿去當索引，`renderTarget.textures[…]`
      // 變成 undefined，然後在 backend 深處丟「Invalid value used as weak map
      // key」—— 那個訊息完全看不出是參數用錯了。
      //
      // `bakeIrradiance` 早就分過這條路，這裡照同一個做法。
      const api = renderer as {
        isWebGPURenderer?: boolean;
        readRenderTargetPixelsAsync: (...args: unknown[]) => Promise<unknown>;
      };
      let data: ArrayLike<number>;
      if (api.isWebGPURenderer === true) {
        data = (await api.readRenderTargetPixelsAsync(
          target,
          0,
          0,
          size,
          size,
          0,
          face,
        )) as ArrayLike<number>;
      } else {
        const buffer = new Uint16Array(size * size * 4);
        await api.readRenderTargetPixelsAsync(target, 0, 0, size, size, buffer, face);
        data = buffer;
      }
      // 兩邊的 target 都是 HalfFloat，所以解碼是同一份。第一版在別的地方
      // 寫成「WebGPU 不解碼」，結果把半精度的位元樣式當成數值用。
      let r = 0;
      let g = 0;
      let b = 0;
      const texels = size * size;
      for (let i = 0; i < texels; i++) {
        r += THREE.DataUtils.fromHalfFloat(data[i * 4] ?? 0);
        g += THREE.DataUtils.fromHalfFloat(data[i * 4 + 1] ?? 0);
        b += THREE.DataUtils.fromHalfFloat(data[i * 4 + 2] ?? 0);
      }
      return [r / texels, g / texels, b / texels];
    },
    nodeReady: async (renderer) => {
      // 先推一次 update 讓它開始建（第一次一定回 false），等好之後再換背景。
      direction.set(0, 1, 0);
      sky.update(renderer as THREE.WebGLRenderer, direction);
      await WW.skyNodeReady(sky);
      scene.background = sky.texture;
    },
    sampleFace: (renderer, face) => {
      const size = sky.target.width;
      renderer.readRenderTargetPixels(sky.target, size >> 1, size >> 1, 1, 1, pixel, face);
      return [
        THREE.DataUtils.fromHalfFloat(pixel[0] ?? 0),
        THREE.DataUtils.fromHalfFloat(pixel[1] ?? 0),
        THREE.DataUtils.fromHalfFloat(pixel[2] ?? 0),
      ];
    },
    bakes: () => sky.bakes,
    bakeProbes: async (renderer) => {
      let baked = 0;
      let guard = 0;
      while (guard++ < 400) {
        const done = await WW.bakeIrradiance(renderer, scene, probes, {
          budgetMs: 8,
          faceSize: 16,
        });
        baked += done;
        if (done === 0) break;
      }
      probes.upload();
      return baked;
    },
    probeAt: (point) => {
      const value = probes.sampleAt(
        new THREE.Vector3(point[0], point[1], point[2]),
        new THREE.Vector3(0, 1, 0),
      );
      return [value.x, value.y, value.z];
    },
  };
}
