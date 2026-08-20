import * as THREE from 'three';
import * as WW from '@webworld/three';

/**
 * 反射的證明場景：一面鏡子，照到一個**不在畫面上**的紅箱子。
 *
 * ## 判準就是那一句「螢幕空間做不到」
 *
 * 紅箱子刻意擺在相機視錐**外面**（夾角 43 度，而水平半視角約 38 度）。
 * 所以：
 *
 * - 螢幕空間那一層在鏡子上追，追到畫面邊緣就沒資料了 → 只剩天空
 * - 距離場那一層在三維裡追，箱子在場裡，所以追得到 → 有顏色
 *
 * 把距離場關掉再量同一個像素，就是這件事最乾淨的 A/B：**同一條著色器路徑、
 * 同一個像素，差別只有「有沒有第二層」**。
 *
 * 而顏色要是紅的 —— 那個紅在這個場景裡只有一個來源。與間接光那條
 * 「背光面偏紅，而紅只可能來自紅牆」是同一個判準形狀。
 */

const MIRROR_HEIGHT = 30;

export interface ReflectionScene {
  root: THREE.Group;
  camera: THREE.PerspectiveCamera;
  /** 把探針與距離場都算完。回傳烘了幾顆。 */
  settle: (renderer: THREE.WebGLRenderer) => Promise<number>;
  /** 畫一次：主畫面 → 深度法線 → 反射。 */
  render: (renderer: THREE.WebGLRenderer, useField: boolean) => void;
  /** 讀反射貼圖上某個世界座標投影到的那一點。跑出畫面回 NaN。 */
  sample: (renderer: THREE.WebGLRenderer, point: THREE.Vector3) => [number, number, number, number];
  points: { mirror: THREE.Vector3; mirrorLow: THREE.Vector3; mirrorGreen: THREE.Vector3 };
  /** 綠箱子在畫面上嗎 —— 螢幕空間那一層的前提。 */
  greenOnScreen: () => boolean;
  /** 紅箱子在畫面上嗎 —— 這個場景的前提，要驗。 */
  boxOnScreen: () => boolean;
  /**
   * 整張反射圖的統計。
   *
   * 手放的取樣點只驗得到想得到的位置 —— 接觸陰影與距離場陰影那兩輪都是
   * 靠整張的統計才驗到最後兩個破壞的。
   */
  stats: (renderer: THREE.WebGLRenderer) => { hit: number; r: number; g: number; b: number };
  setRoughness: (value: number) => void;
}

function targetOf(reflections: WW.TracedReflections): THREE.WebGLRenderTarget {
  return (reflections as unknown as { target: THREE.WebGLRenderTarget }).target;
}

export function makeReflectionScene(): ReflectionScene {
  const root = new THREE.Group();

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 300),
    new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  root.add(ground);

  // 鏡面：一片朝 +x 的牆。它本身不必真的是鏡子 —— 反射是後製算的，這裡只要
  // 它出現在深度法線裡，法線朝 +x。
  const mirror = new THREE.Mesh(
    new THREE.PlaneGeometry(60, MIRROR_HEIGHT),
    new THREE.MeshStandardMaterial({ color: 0x707070, roughness: 0.05, metalness: 0.9 }),
  );
  mirror.position.set(0, MIRROR_HEIGHT / 2, 0);
  mirror.rotation.y = Math.PI / 2;
  mirror.updateMatrixWorld(true);
  root.add(mirror);

  // ## 紅箱子：畫面外，但在場裡
  //
  // 位置是算過的 —— 從相機看鏡子上那一點，反射出去的射線正好打到它。
  const boxGeometry = new THREE.BoxGeometry(18, 18, 18);
  const box = new THREE.Mesh(
    boxGeometry,
    new THREE.MeshStandardMaterial({ color: 0xff1010, roughness: 1 }),
  );
  box.position.set(34, 9, -48);
  box.updateMatrixWorld(true);
  root.add(box);

  // ## 一個綠箱子：這一顆**在畫面上**
  //
  // 紅箱子驗的是距離場那一層（畫面外），而螢幕空間那一層要另外驗 —— 少了
  // 起點偏移的話，第一步就打到鏡子自己，鏡子會反射出自己的顏色。而那個
  // 破壞在只有畫面外的取樣點時完全看不到（螢幕空間那一層本來就沒貢獻）。
  //
  // 位置是算的：從相機看鏡子上 (0, 6, 12)，反射出去正好打到它。
  const greenBox = new THREE.Mesh(
    new THREE.BoxGeometry(9, 9, 9),
    new THREE.MeshStandardMaterial({ color: 0x10ff30, roughness: 1 }),
  );
  greenBox.position.set(27, 3, 0);
  greenBox.updateMatrixWorld(true);
  root.add(greenBox);

  const sun = new THREE.DirectionalLight(0xffffff, 4);
  sun.position.set(30, 60, 20);
  root.add(sun);

  // 反照率要**自己給**：表面快取讀的是頂點顏色或這個選項，它看不到材質。
  // 不給的話預設是白的，而反射到一個紅箱子會拿到白色 —— 實測踩過。
  const volume = new WW.DistanceFieldVolume(boxGeometry, {
    resolution: 32,
    padding: 0.3,
    albedo: [1, 0.06, 0.06],
  });
  const field = new WW.GlobalDistanceField({ resolution: 48, extent: 200, budget: 200000 });
  field.add({ volume, matrixWorld: box.matrixWorld });

  // 探針：距離場那一層打到東西之後，亮度由它回答。體積要蓋住箱子那一帶。
  const probes = new WW.IrradianceVolume({
    min: new THREE.Vector3(-40, 0, -70),
    size: new THREE.Vector3(110, 40, 110),
    resolution: [10, 4, 10],
    intensity: 1,
  });

  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 600);
  camera.position.set(40, 12, 30);
  camera.lookAt(0, 8, 0);
  camera.updateMatrixWorld(true);

  const reflections = new WW.TracedReflections({
    // 32 步 × 1.5 = 48 單位。鏡子到綠箱子是 29.7 —— 第一版 32 × 0.8 = 25.6
    // 構不到，於是螢幕空間那一層什麼都沒找到，而那看起來像它壞了。
    screenSteps: 32,
    screenStep: 1.5,
    thickness: 2,
    fieldSteps: 64,
    roughness: 0.1,
    sky: new THREE.Color(0x101828),
  });

  /**
   * 鏡子上哪一點會照到 `target`。
   *
   * ## 用算的，不要用手算
   *
   * 鏡面在 x = 0、法線 +x，所以 `target` 的鏡像就是 x 取負。相機到鏡像的
   * 連線與鏡面的交點，就是那個東西出現在鏡子上的位置。
   *
   * 手算過一次，而且算對了 —— 但每次挪動箱子都要重算一遍，遲早會忘。
   * 推導寫進程式裡就不會跟場景分家。
   */
  const mirrorPointFor = (target: THREE.Vector3): THREE.Vector3 => {
    const image = new THREE.Vector3(-target.x, target.y, target.z);
    const t = camera.position.x / (camera.position.x - image.x);
    return new THREE.Vector3(0, 0, 0).lerpVectors(camera.position, image, t);
  };

  const scene = new THREE.Scene();
  scene.add(root);

  // 全解析度的深度法線。預設是半解析度（那對真的應用是對的取捨），但這裡是
  // 量測台 —— 重取樣的誤差會混進每一個判準裡，而那不是這一關要量的東西。
  const world = WW.worldFor(scene);
  world.setDepthNormals({ scale: 1 });

  // 主畫面畫進一張 target —— 螢幕空間那一層要取樣它。
  const colorTarget = new THREE.WebGLRenderTarget(1280, 720, { type: THREE.HalfFloatType });

  const pixel = new Float32Array(4);
  const halfPixel = new Uint16Array(4);
  const projected = new THREE.Vector3();

  return {
    root,
    camera,
    settle: async (renderer) => {
      let rounds = 0;
      while (field.pendingCells > 0 && rounds < 400) {
        field.update(new THREE.Vector3(0, 0, 0));
        rounds++;
      }
      let baked = 0;
      let guard = 0;
      while (probes.baked < probes.probeCount && guard++ < 600) {
        baked += await WW.bakeIrradiance(renderer, scene, probes, { budgetMs: 8, faceSize: 16 });
      }
      probes.upload();
      return baked;
    },
    render: (renderer, useField) => {
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(colorTarget);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
      renderer.setRenderTarget(previous);

      world.beginFrame();
      reflections.render(renderer, scene, camera, {
        color: colorTarget.texture,
        field: useField ? field : null,
        // `probes` 是一個 IrradianceVolume —— 舊的位置參數版本這裡看不出來
        // 它進的是哪一格，而那正是換成具名的理由。
        irradiance: useField ? probes : null,
      });
    },
    sample: (renderer, point) => {
      const target = targetOf(reflections);
      projected.copy(point).project(camera);
      if (
        projected.x < -1 ||
        projected.x > 1 ||
        projected.y < -1 ||
        projected.y > 1 ||
        projected.z > 1
      ) {
        return [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
      }
      const x = Math.round(((projected.x + 1) / 2) * target.width);
      const y = Math.round(((projected.y + 1) / 2) * target.height);
      // ## 半精度的 target 要用 Uint16 讀再解碼
      //
      // 用 Float32Array 去讀會拿到一整片 0，而 0 剛好長得像「沒有反射」——
      // 這個專案已經在 SSGI 那邊踩過一次。
      renderer.readRenderTargetPixels(
        target,
        Math.min(target.width - 1, Math.max(0, x)),
        Math.min(target.height - 1, Math.max(0, y)),
        1,
        1,
        halfPixel,
      );
      for (let i = 0; i < 4; i++) pixel[i] = THREE.DataUtils.fromHalfFloat(halfPixel[i] ?? 0);
      return [pixel[0]!, pixel[1]!, pixel[2]!, pixel[3]!];
    },
    points: {
      // 鏡子上那一點：從相機看過去，反射出去正好打到紅箱子。
      mirror: mirrorPointFor(box.position),
      // 鏡子上比較低的一點 —— 反射的角度不同，用來確認不是整面一個顏色。
      mirrorLow: mirrorPointFor(new THREE.Vector3(20, 20, -10)),
      // 鏡子上這一點反射的是**畫面上**那顆綠箱子 —— 螢幕空間那一層負責。
      mirrorGreen: mirrorPointFor(greenBox.position),
    },
    greenOnScreen: () => {
      const p = greenBox.position.clone().project(camera);
      return p.x >= -1 && p.x <= 1 && p.y >= -1 && p.y <= 1 && p.z <= 1;
    },
    boxOnScreen: () => {
      // ## 要驗八個角，不是只驗中心
      //
      // 箱子 18 單位，中心在畫面外不代表整顆都在外面 —— 而只要有一角進了
      // 畫面，螢幕空間那一層就找得到它，整關的前提就垮了。實測踩過：把追蹤
      // 距離拉長之後，那一角就被找到了。
      const h = 9;
      const corner = new THREE.Vector3();
      for (let i = 0; i < 8; i++) {
        corner.set(
          box.position.x + (i & 1 ? h : -h),
          box.position.y + (i & 2 ? h : -h),
          box.position.z + (i & 4 ? h : -h),
        );
        corner.project(camera);
        if (corner.x >= -1 && corner.x <= 1 && corner.y >= -1 && corner.y <= 1 && corner.z <= 1) {
          return true;
        }
      }
      return false;
    },
    stats: (renderer) => {
      const target = targetOf(reflections);
      const buffer = new Uint16Array(target.width * target.height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, buffer);
      let hit = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      const total = target.width * target.height;
      for (let i = 0; i < buffer.length; i += 4) {
        r += THREE.DataUtils.fromHalfFloat(buffer[i] ?? 0);
        g += THREE.DataUtils.fromHalfFloat(buffer[i + 1] ?? 0);
        b += THREE.DataUtils.fromHalfFloat(buffer[i + 2] ?? 0);
        if (THREE.DataUtils.fromHalfFloat(buffer[i + 3] ?? 0) > 0.5) hit++;
      }
      return { hit: hit / total, r: r / total, g: g / total, b: b / total };
    },
    setRoughness: (value) => {
      reflections.roughness = value;
    },
  };
}
