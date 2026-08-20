import * as THREE from 'three';
import * as WW from '@webworld/three';
import { readPixelsAsync } from './readback.ts';

/**
 * 反射探針的證明場景：四面牆各一個顏色的房間，地板照得出它們。
 *
 * ## 為什麼要四個顏色
 *
 * 反射探針把整個方向球攤成一張正方形（八面體映射），而那張圖的方向對應
 * 在 CPU 與 GLSL 各有一份實作。兩份對不起來的症狀是**反射裡的世界被鏡射
 * 或轉了 90 度** —— 而單一顏色的環境看不出任何差別。
 *
 * 四面牆各一個顏色之後，「地板上偏 +x 那一塊該照出紅色」就是一個問得出
 * 答案的問題。
 *
 * ## 為什麼 roughness 開到 1
 *
 * `TracedReflections` 有三層：螢幕空間、距離場、探針。要量探針那一層就得
 * 讓另外兩層閉嘴 —— roughness 1 讓螢幕空間的權重歸零，而這個場景不建
 * 距離場。於是畫面上讀到的**就是**探針答出來的東西。
 *
 * 三層混在一起量的話，量到的差異分不出是哪一層造成的。
 */

const ROOM = 100;
/**
 * 牆要**很高**。
 *
 * 相機俯看地板，所以地板上每一點的反射方向都是往上斜的 —— 仰角等於視線的
 * 俯角。實測地板上偏 +z 25 個單位那一點的反射仰角是 67 度，走到 z = 100 的
 * 牆面時已經 180 個單位高。牆只有 200 的話那條射線幾乎擦著牆頂過去，而
 * 「差一點打到」與「打到」在畫面上是黑色與綠色的差別。
 */
const WALL_HEIGHT = 300;

export interface ReflectionProbeScene {
  root: THREE.Group;
  camera: THREE.PerspectiveCamera;
  /**
   * 把所有探針烘完，回傳烘了幾顆。
   *
   * 是非同步的 —— 烘焙最貴的一段是等 GPU 把 cubemap 讀回來，而那是一個
   * `await`。不等它就取樣的話讀到的是還沒寫進去的圖集，量出來全黑。
   */
  settle: (renderer: THREE.WebGLRenderer) => Promise<number>;
  /** 畫一次反射。`useProbes` 關掉就是原本那條「什麼都沒打到就用天空色」。 */
  render: (renderer: THREE.WebGLRenderer, useProbes: boolean, debug?: number) => void;
  /**
   * 同一件事，非同步 —— WebGPU 沒有同步的讀回。讀一小塊的平均。
   */
  sampleWindowAsync: (renderer: unknown, x: number, z: number, size: number) => Promise<number[]>;
  /** 等 WebGPU 那條路建好。 */
  nodeReady: (renderer: unknown) => Promise<void>;
  /** 地板上某一點照出來的顏色。 */
  sampleAt: (renderer: THREE.WebGLRenderer, x: number, z: number) => [number, number, number];
  /** 那一點在畫面上的位置 —— 關卡要先確定它真的在畫面裡。 */
  screenAt: (x: number, z: number) => [number, number];
  /** 那面「串流進來的」牆現身。 */
  reveal: () => void;
  /** 通知探針那一區變了。分開放是為了驗「不通知就會留著舊資料」。 */
  invalidate: () => number;
  info: () => { probes: number; baked: number; written: number; stale: number };
  debug: (renderer: THREE.WebGLRenderer) => unknown;
}

export function makeReflectionProbeScene(): ReflectionProbeScene {
  const root = new THREE.Group();
  const scene = new THREE.Scene();
  scene.add(root);

  // 牆用 MeshBasicMaterial：顏色不受光照影響，所以拍到什麼是**確定的**。
  // 用 Standard 的話量到的顏色同時取決於光源角度，而那不是這裡要測的東西。
  const wall = (color: number, position: THREE.Vector3, rotationY: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM * 2, WALL_HEIGHT),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
    );
    mesh.position.copy(position);
    mesh.rotation.y = rotationY;
    mesh.updateMatrixWorld(true);
    root.add(mesh);
    return mesh;
  };

  wall(0xff0000, new THREE.Vector3(ROOM, WALL_HEIGHT / 2, 0), -Math.PI / 2); // +x 紅
  wall(0x0000ff, new THREE.Vector3(-ROOM, WALL_HEIGHT / 2, 0), Math.PI / 2); // −x 藍
  wall(0xffff00, new THREE.Vector3(0, WALL_HEIGHT / 2, -ROOM), 0); // −z 黃

  // ## 這一面是「串流進來的」
  //
  // 一開始藏著 —— 代表那一格內容還沒到。探針在這個狀態下烘完之後，那個方向
  // 記的是「什麼都沒有」。串流把牆送進來時要是沒人通知探針，它會**永遠**
  // 停在那份舊資料上，而畫面不會報錯。
  const streamed = wall(0x00ff00, new THREE.Vector3(0, WALL_HEIGHT / 2, ROOM), 0); // +z 綠
  streamed.visible = false;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM * 2, ROOM * 2),
    new THREE.MeshBasicMaterial({ color: 0x101010 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.updateMatrixWorld(true);
  root.add(floor);

  // ## 體積的底刻意比地板**高 0.05**
  //
  // 反射查表是拿「反射點的世界座標」去找探針的，而反射點就在地板上（y = 0）。
  // 體積底高於地板的話那些點全部落在體積外，查表回退，於是整片地板的反射
  // 永遠是天空色 —— 看起來像這整套完全沒作用。
  //
  // 這是真的會發生的擺法（誰都會把體積的底對到地面），所以查表對邊界留了
  // 一點容差。而這裡刻意差 0.05，是為了讓那個容差**確定**被踩到：
  //
  // 第一版把底對齊 0，靠的是「深度重建出來的座標會落在 −0.0001」——
  // 那確實發生了，而且就是這樣抓到這個 bug 的。但誤差的正負號跟著相機
  // 位置變：相機從 40 抬到 60 之後它變成 0，破壞容差竟然還是綠的。
  // 靠浮點誤差的關卡是會隨機變綠的關卡。
  const volume = new WW.IrradianceVolume({
    min: new THREE.Vector3(-ROOM, 0.05, -ROOM),
    size: new THREE.Vector3(ROOM * 2, 100, ROOM * 2),
    resolution: [4, 2, 4],
  });
  const probes = new WW.ReflectionProbes(volume, { tileSize: 16 });

  // 相機直接俯看地板。牆完全不在畫面上 —— 螢幕空間那一層本來就找不到它們，
  // 而這正是探針要補的那一段。
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 1, 900);
  // 站高一點：視野裡的地板範圍才夠大，偏 +z 那個取樣點才進得了畫面。
  // 40 的時候可見範圍只到 ±23，而那個點要 25。
  camera.position.set(0, 60, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const gbuffer = new WW.SceneDepthNormals({ scale: 1 });
  const reflections = new WW.TracedReflections({
    // 1 = 完全霧面：螢幕空間那一層的權重歸零。
    roughness: 1,
    // 沒打到東西時的顏色。探針接的就是這一條，所以它必須是一個**不會被
    // 誤認成任何一面牆**的顏色。
    sky: new THREE.Color(0x000000),
  });
  const colorTarget = new THREE.WebGLRenderTarget(1280, 720, {
    colorSpace: THREE.NoColorSpace,
    type: THREE.HalfFloatType,
  });

  const half = new Uint16Array(4);
  const point = new THREE.Vector3();

  /** 一幀。`nodeReady` 也要用它。 */
  const draw = (renderer: THREE.WebGLRenderer, useProbes: boolean, debug = 0): void => {
    (reflections as unknown as { debugMode: number }).debugMode = debug;
    renderer.setRenderTarget(colorTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    gbuffer.update(renderer, scene, camera);
    reflections.render(renderer, camera, gbuffer, colorTarget.texture, null, null, useProbes ? probes : null);
  };

  return {
    root,
    camera,
    settle: async (renderer) => {
      let baked = 0;
      // 預算開大讓一輪盡量多烘幾顆，但仍然要迴圈 —— 預算管的是「發出去」
      // 那一段，發完就會停手等讀回。
      for (let round = 0; round < 400; round++) {
        const done = await WW.bakeIrradiance(renderer, scene, volume, {
          budgetMs: 1000,
          faceSize: 16,
          reflection: probes,
        });
        if (done === 0) break;
        baked += done;
      }
      return baked;
    },
    render: draw,
    screenAt: (x, z) => {
      point.set(x, 0, z).project(camera);
      return [(point.x + 1) / 2, (point.y + 1) / 2];
    },
    sampleWindowAsync: async (renderer, x, z, size) => {
      const target = (reflections as unknown as { target: THREE.WebGLRenderTarget }).target;
      point.set(x, 0, z).project(camera);
      const half = size >> 1;
      const px = Math.min(
        target.width - size,
        Math.max(0, Math.round(((point.x + 1) / 2) * target.width) - half),
      );
      const py = Math.min(
        target.height - size,
        Math.max(0, Math.round(((point.y + 1) / 2) * target.height) - half),
      );
      const data = await readPixelsAsync(
        renderer,
        target,
        px,
        py,
        size,
        size,
        (n) => new Uint16Array(n),
      );
      const sum = [0, 0, 0];
      for (let i = 0; i < size * size; i++) {
        for (let c = 0; c < 3; c++) sum[c]! += THREE.DataUtils.fromHalfFloat(data[i * 4 + c] ?? 0);
      }
      return sum.map((v) => v / (size * size));
    },
    nodeReady: async (renderer) => {
      // node 材質是動態 import 進來的 —— 要等**真的時間**，microtask 不夠。
      for (let i = 0; i < 60; i++) {
        draw(renderer as THREE.WebGLRenderer, true);
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    },
    sampleAt: (renderer, x, z) => {
      const target = (reflections as unknown as { target: THREE.WebGLRenderTarget }).target;
      point.set(x, 0, z).project(camera);
      const px = Math.round(((point.x + 1) / 2) * target.width);
      const py = Math.round(((point.y + 1) / 2) * target.height);
      renderer.readRenderTargetPixels(target, px, py, 1, 1, half);
      return [
        THREE.DataUtils.fromHalfFloat(half[0] ?? 0),
        THREE.DataUtils.fromHalfFloat(half[1] ?? 0),
        THREE.DataUtils.fromHalfFloat(half[2] ?? 0),
      ];
    },
    reveal: () => {
      streamed.visible = true;
    },
    invalidate: () => volume.invalidateAround(new THREE.Vector3(0, 0, ROOM), ROOM * 1.5),
    debug: (renderer) => {
      // 圖集裡到底有沒有東西 —— 全黑代表烘那一段壞了，有顏色代表著色器那段壞了。
      const data = probes.texture.image.data as Uint16Array;
      let maxR = 0;
      let maxG = 0;
      let maxB = 0;
      for (let i = 0; i < data.length; i += 4) {
        maxR = Math.max(maxR, THREE.DataUtils.fromHalfFloat(data[i] ?? 0));
        maxG = Math.max(maxG, THREE.DataUtils.fromHalfFloat(data[i + 1] ?? 0));
        maxB = Math.max(maxB, THREE.DataUtils.fromHalfFloat(data[i + 2] ?? 0));
      }
      // 場景本身有沒有畫出來（地板該是 0x101010）。
      const sceneHalf = new Uint16Array(4);
      point.set(30, 0, 0).project(camera);
      renderer.readRenderTargetPixels(
        colorTarget,
        Math.round(((point.x + 1) / 2) * colorTarget.width),
        Math.round(((point.y + 1) / 2) * colorTarget.height),
        1,
        1,
        sceneHalf,
      );
      const u = (reflections as unknown as { material: THREE.ShaderMaterial }).material.uniforms;
      return {
        atlasMax: [maxR, maxG, maxB],
        atlasSize: [probes.texture.image.width, probes.texture.image.height],
        sceneColor: [
          THREE.DataUtils.fromHalfFloat(sceneHalf[0] ?? 0),
          THREE.DataUtils.fromHalfFloat(sceneHalf[1] ?? 0),
          THREE.DataUtils.fromHalfFloat(sceneHalf[2] ?? 0),
        ],
        hasProbes: u.uHasProbes?.value,
        reflMin: (u.wwReflMin?.value as THREE.Vector3)?.toArray?.(),
        reflInvSize: (u.wwReflInvSize?.value as THREE.Vector3)?.toArray?.(),
        reflResolution: (u.wwReflResolution?.value as THREE.Vector3)?.toArray?.(),
        reflColumns: u.wwReflColumns?.value,
        reflStride: u.wwReflStride?.value,
        reflAtlasSize: (u.wwReflAtlasSize?.value as THREE.Vector3)?.toArray?.(),
        atlasBound: u.wwReflAtlas?.value === probes.texture,
      };
    },
    info: () => ({
      probes: volume.probeCount,
      baked: volume.baked,
      written: probes.written,
      stale: volume.stale,
    }),
  };
}
