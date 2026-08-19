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
        const done = await WW.bakeIrradiance(renderer, scene, probes, { budgetMs: 8, faceSize: 16 });
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
