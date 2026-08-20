import * as THREE from 'three';
import * as WW from '@webworld/three';
import { readPixelsAsync } from './readback.ts';

/**
 * 體積霧的證明場景：一面有缺口的牆，太陽在後面。
 *
 * ## 為什麼要這樣擺
 *
 * 第一版拿距離場陰影那個場景來量（一個箱子在空地上），量到**開關距離場完全
 * 沒有差別**。原因不是效果壞了：那個箱子的影子只有 12 單位長，而視線總長
 * 220 單位 —— 48 步裡只有兩三步落在影子裡，佔散射的 5%，淹在雜訊裡。
 *
 * 光柱要看得出來，遮蔽物必須**擋住視線的一大段**。所以這裡是一面大牆加一個
 * 缺口：穿過缺口的那些射線一路都被照到，被牆擋住的那些一路都在影子裡。
 *
 * 那正是「光柱」這個詞的字面意思 —— 而它也是這個效果唯一真正難的地方。
 */

const WALL_WIDTH = 200;
const WALL_HEIGHT = 90;
const GAP = 26;

export interface FogScene {
  root: THREE.Group;
  camera: THREE.PerspectiveCamera;
  settle: () => number;
  render: (renderer: THREE.WebGLRenderer, useField: boolean) => void;
  /**
   * 同一件事，非同步 —— WebGPU 沒有同步的讀回。
   *
   * 讀一小塊的平均：霧是一步一步積出來的，單點會被抖動的相位帶走。
   */
  sampleWindowAsync: (renderer: unknown, u: number, v: number, size: number) => Promise<number[]>;
  /** 等 WebGPU 那條路建好。 */
  nodeReady: (renderer: unknown) => Promise<void>;
  /** 讀某個螢幕比例位置的霧：RGB 是散射光，A 是透光率。 */
  sampleAt: (renderer: THREE.WebGLRenderer, u: number, v: number) => [number, number, number, number];
  /**
   * 一小塊區域裡相鄰像素的變異。
   *
   * 抖動起點的直接後果就是**相鄰像素不一樣**：條帶被換成雜訊。固定起點
   * 的話同一塊區域裡每個像素的取樣位置一模一樣，變異幾乎是 0。
   *
   * 這是「抖動有沒有開」唯一量得到的地方 —— 單點取樣看不出條帶。
   */
  localVariance: (renderer: THREE.WebGLRenderer, u: number, v: number) => number;
  /** 缺口與牆體在畫面上的位置（比例），測試要用同一組。 */
  spots: { throughGap: [number, number]; behindWall: [number, number]; sky: [number, number] };
}

export function makeFogScene(): FogScene {
  const root = new THREE.Group();
  const scene = new THREE.Scene();
  scene.add(root);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  root.add(ground);

  // ## 牆用兩塊拼出缺口
  //
  // 一整片挖洞要改幾何；兩塊中間留空是同一件事，而且距離場那邊也乾淨
  // （兩個各自的體積，缺口自然就是「兩個場都很遠」的地方）。
  const material = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 1 });
  const halfWidth = (WALL_WIDTH - GAP) / 2;
  const slabGeometry = new THREE.BoxGeometry(10, WALL_HEIGHT, halfWidth);

  const field = new WW.GlobalDistanceField({ resolution: 64, extent: 400, budget: 400000 });
  const slabs: THREE.Mesh[] = [];
  for (const sign of [-1, 1]) {
    const slab = new THREE.Mesh(slabGeometry, material);
    slab.position.set(0, WALL_HEIGHT / 2, sign * (GAP / 2 + halfWidth / 2));
    slab.updateMatrixWorld(true);
    root.add(slab);
    slabs.push(slab);
    const volume = new WW.DistanceFieldVolume(slabGeometry, {
      resolution: 32,
      padding: 0.2,
      albedo: [0.6, 0.6, 0.6],
    });
    field.add({ volume, matrixWorld: slab.matrixWorld });
  }

  // 太陽在牆的另一側，而且低 —— 光柱在低角度最明顯。
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(160, 55, 0);
  root.add(sun);
  const lightDirection = new THREE.Vector3(0, 0, 0).sub(sun.position).normalize();

  // 相機在牆的這一側，看著牆 —— 缺口在畫面正中央。
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 1, 900);
  camera.position.set(-120, 30, 0);
  camera.lookAt(0, 30, 0);
  camera.updateMatrixWorld(true);

  const gbuffer = new WW.SceneDepthNormals({ scale: 1 });
  const fog = new WW.VolumetricFog({
    // 視線總長 220，密度 0.004 → 光學深度約 0.9，透光率約 0.4。
    // 第一版用 0.06 直接把畫面糊成一片白（透光率 0.001）。
    density: 0.004,
    // ## 步數刻意壓低到 10
    //
    // 起點抖動要對付的是**條帶**，而條帶在步數多的時候本來就淺 —— 48 步時
    // 開關抖動的相鄰變異只差 7%（2.91% 對 2.71%），訂不出門檻。
    //
    // 壓到 10 步之後每一步 22 個單位，條帶明顯，抖動的效果才量得到。
    // 測試要**逼出**它要測的東西，不是在最舒服的設定下量。
    steps: 10,
    range: 220,
    anisotropy: 0.7,
    shadowSteps: 32,
  });

  const half = new Uint16Array(4);
  const fieldCentre = new THREE.Vector3(0, 30, 0);

  const white = new THREE.Color(0xffffff);
  /** 一幀。`nodeReady` 也要用它。 */
  const drawOnce = (renderer: THREE.WebGLRenderer, useField: boolean): void => {
    gbuffer.update(renderer, scene, camera);
    fog.render(renderer, camera, gbuffer, lightDirection, white, useField ? field : null);
  };

  return {
    root,
    camera,
    settle: () => {
      let rounds = 0;
      while (field.pendingCells > 0 && rounds < 400) {
        field.update(fieldCentre);
        rounds++;
      }
      return rounds;
    },
    render: drawOnce,
    sampleWindowAsync: async (renderer, u, v, size) => {
      const target = (fog as unknown as { target: THREE.WebGLRenderTarget }).target;
      const half = size >> 1;
      const x = Math.min(target.width - size, Math.max(0, Math.round(u * target.width) - half));
      const y = Math.min(target.height - size, Math.max(0, Math.round(v * target.height) - half));
      const data = await readPixelsAsync(
        renderer,
        target,
        x,
        y,
        size,
        size,
        (n) => new Uint16Array(n),
      );
      const sum = [0, 0, 0, 0];
      for (let i = 0; i < size * size; i++) {
        for (let c = 0; c < 4; c++) sum[c]! += THREE.DataUtils.fromHalfFloat(data[i * 4 + c] ?? 0);
      }
      return sum.map((v2) => v2 / (size * size));
    },
    nodeReady: async (renderer) => {
      // node 材質是動態 import 進來的 —— 要等**真的時間**，microtask 不夠。
      for (let i = 0; i < 60; i++) {
        drawOnce(renderer as THREE.WebGLRenderer, true);
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    },
    sampleAt: (renderer, u, v) => {
      const target = (fog as unknown as { target: THREE.WebGLRenderTarget }).target;
      const x = Math.min(target.width - 1, Math.max(0, Math.round(u * target.width)));
      const y = Math.min(target.height - 1, Math.max(0, Math.round(v * target.height)));
      renderer.readRenderTargetPixels(target, x, y, 1, 1, half);
      return [
        THREE.DataUtils.fromHalfFloat(half[0] ?? 0),
        THREE.DataUtils.fromHalfFloat(half[1] ?? 0),
        THREE.DataUtils.fromHalfFloat(half[2] ?? 0),
        THREE.DataUtils.fromHalfFloat(half[3] ?? 0),
      ];
    },
    localVariance: (renderer, u, v) => {
      const target = (fog as unknown as { target: THREE.WebGLRenderTarget }).target;
      const size = 8;
      const x = Math.min(target.width - size, Math.max(0, Math.round(u * target.width)));
      const y = Math.min(target.height - size, Math.max(0, Math.round(v * target.height)));
      const block = new Uint16Array(size * size * 4);
      renderer.readRenderTargetPixels(target, x, y, size, size, block);
      const values: number[] = [];
      for (let i = 0; i < block.length; i += 4) {
        values.push(THREE.DataUtils.fromHalfFloat(block[i] ?? 0));
      }
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
      return Math.sqrt(variance) / Math.max(mean, 1e-6);
    },
    spots: {
      // 缺口在 z = 0，相機看著它 —— 畫面正中央偏上（牆高 90，相機在 30）。
      throughGap: [0.5, 0.62],
      // 牆體那一側：同樣的高度，但水平上偏開，射線被牆擋住。
      behindWall: [0.78, 0.62],
      // 牆頂上方的天空：深度固定（走滿 range）、場景平滑 —— 那裡的變異
      // 幾乎只可能來自抖動，量得到抖動有沒有開。
      sky: [0.5, 0.12],
    },
  };
}
