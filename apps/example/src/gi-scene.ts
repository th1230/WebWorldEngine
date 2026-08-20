import * as THREE from 'three';
import * as WW from '@webworld/three';
import { readPixelsAsync } from './readback.ts';

/**
 * 間接光的證明場景：一面紅地板、一顆白箱子、一盞從上面來的光。
 *
 * ## 為什麼是這個佈置
 *
 * 要證明「間接光真的在起作用」，最容易造假的指標是**亮度** —— 隨便哪裡
 * 寫錯一個係數、或不小心多加了一盞環境光，畫面都會變亮，而「變亮了」會被
 * 讀成「間接光生效了」。
 *
 * 所以這裡量的不是亮度，是**顏色**：
 *
 * - 地板是紅的，箱子是白的，場景裡**沒有環境光、沒有 env map**。
 * - 箱子的背光面（朝下、朝暗側）拿不到任何直接光，所以沒有間接光時它是**全黑**。
 * - 有間接光時，它唯一能拿到的光是**從紅地板反彈上來的**，所以它會偏紅。
 *
 * 於是判準是「背光面的紅比藍多多少」。這個訊號只有反彈光做得出來 ——
 * 加一盞白色環境光會讓紅藍一起上去，比值不動；係數寫錯會讓它整個不亮。
 *
 * 這是 [doctrine](../../../specs/doctrine.md) 第 13 條的用法：換一把尺，
 * 讓「碰巧看起來對」變得更難。
 */

export interface GiScene {
  root: THREE.Group;
  volume: WW.IrradianceVolume;
  /** 烘一點點。回傳這一次烘了幾顆。 */
  bake(renderer: THREE.WebGLRenderer, scene: THREE.Scene): Promise<number>;
  /** 把間接光整個關掉 —— A/B 用。node 材質那條路要重編，所以是非同步的。 */
  setEnabled(on: boolean): Promise<void>;
  stats: () => { probes: number; baked: number; materials: number; stale: number };
  /**
   * 把那塊藍板子搬到某個位置，並且把附近的探針標成過期。
   *
   * 這是「會動的東西不反彈光」那個限制的驗證用具：板子是藍的，箱子是白的，
   * 房間是紅的 —— 板子搬到箱子旁邊之後，箱子那一面應該**變藍**。
   *
   * 藍色在這個場景裡沒有別的來源，所以它是個乾淨的訊號（與紅房間那一條
   * 判準同一個道理）。
   */
  /**
   * 把**每一顆**探針標成過期。
   *
   * 這正是太陽移動的形狀：東西沒動，但每一顆探針收到的光都變了。
   * `invalidateAround` 是局部的（東西移動），這一支是全域的（光源移動）。
   */
  invalidateAll: () => number;
  /**
   * 把太陽移到某個角度（0–1 掃過一段天空），並讓每一顆探針過期。
   *
   * 日夜循環的驗證用具：烘兩個角度各存一份關鍵幀，然後看內插對不對。
   */
  setSun: (phase: number) => void;
  /** 直接讀探針在某一點的輻照度 —— 相位內插對不對要看這個。 */
  volumePhase: (t: number) => void;
  moveBlocker: (x: number, y: number, z: number) => number;
  /**
   * 螢幕空間那條路：把場景畫一次，收集間接光，回傳量到的顏色。
   *
   * 與探針那條路量的是**同一件事**（白箱子的背光面沾到多少紅），所以
   * 兩邊的數字直接可比。
   */
  measureScreenSpace: (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    rect: [number, number, number, number],
  ) => { r: number; g: number; b: number; perFrameMs: number };
  /** 一直烘到沒有過期的為止。回傳烘了幾顆。 */
  bakeStale: (renderer: THREE.WebGLRenderer, scene: THREE.Scene) => Promise<number>;
  /**
   * 把場景畫進自己的 target，讀回一小塊的平均顏色。
   *
   * ## 為什麼要有這一支
   *
   * `sampleCpu` 量的是**烘出來的 SH**，而那只是一半 —— 著色端還要把它取樣
   * 出來加進光照。兩邊的 SH 對得上而畫出來的差兩倍，是這個專案量過的事實，
   * 而那個差距在只比 SH 的關卡底下完全看不見。
   *
   * 相機是**場景自己的**，不是頁面的：兩個頁面的畫布大小不見得一樣，而
   * 「畫面的第幾個像素」要是同一件事才比得下去。
   */
  renderedWindowAsync: (
    renderer: unknown,
    scene: THREE.Scene,
    u: number,
    v: number,
    size: number,
  ) => Promise<number[]>;
  /** 用 CPU 那份公式在同一個位置求值 —— 拿來分辨「烘的不一樣」還是「著色的不一樣」。 */
  sampleCpu: (p: [number, number, number], n: [number, number, number]) => [number, number, number];
}

/** SSGI 的輸出 target —— 量測要讀它，而那不是公開介面。 */
function ssgiTargetOf(ssgi: WW.ScreenSpaceGI): THREE.WebGLRenderTarget {
  return (ssgi as unknown as { gatherTarget: THREE.WebGLRenderTarget }).gatherTarget;
}

const ROOM = 40;

/**
 * 材質工廠。WebGL 那頁給 `MeshStandardMaterial`，WebGPU 那頁給
 * `MeshStandardNodeMaterial`。
 *
 * 兩條路共用**同一個場景建構函式**是刻意的：各自寫一份「差不多的場景」的話，
 * 量到的差異可能來自佈置不同而不是實作不同，而那種比較說明不了任何事。
 */
export type MaterialFactory = (color: number, roughness: number) => THREE.Material;

const defaultMaterial: MaterialFactory = (color, roughness) =>
  new THREE.MeshStandardMaterial({ color, roughness });

export function makeGiScene(
  makeMaterial: MaterialFactory = defaultMaterial,
  /**
   * 起始強度。**node 材質那條路只認這個值**（它是編譯期常數，見
   * `irradiance-node.ts`），所以 WebGPU 上的 A/B 是靠開兩次頁面做的。
   */
  intensity = 1,
  /** cubemap 每面邊長 —— 拿來量「烘的成本是被像素還是被讀回綁住」。 */
  faceSize = 16,
  /** 探針網格解析度 —— 拿來量「接觸尺度的反彈是不是解析度問題」。 */
  probeRes = 8,
): GiScene {
  const root = new THREE.Group();

  // ## 紅地板：反彈光的來源
  //
  // 顏色要飽和 —— 反彈光的強度大約是「入射光 × 反照率」，而我們要量的是
  // 紅藍**比值**，所以藍色分量越低訊號越乾淨。
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM * 2, ROOM * 2),
    makeMaterial(0xcc1010, 1),
  );
  floor.rotation.x = -Math.PI / 2;
  root.add(floor);

  // 兩面側牆讓反彈光有地方來 —— 只有地板的話探針上半球幾乎都是黑的。
  for (const [x, z, ry] of [
    [-ROOM, 0, Math.PI / 2],
    [0, -ROOM, 0],
  ] as const) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(ROOM * 2, ROOM), makeMaterial(0xcc1010, 1));
    wall.position.set(x, ROOM / 2, z);
    wall.rotation.y = ry;
    root.add(wall);
  }

  // ## 白箱子：被反彈光照到的東西
  //
  // 白色是因為它不能自己帶顏色 —— 帶紅色的話「它偏紅」就證明不了任何事。
  const box = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), makeMaterial(0xffffff, 0.9));
  box.position.set(0, 14, 0);
  root.add(box);

  // ## 光：只有一盞方向光，**沒有環境光**
  //
  // 有環境光的話箱子的背面本來就是亮的，那就量不到間接光了 —— 而那正是
  // 最容易不小心犯的錯：場景裡留了一盞 AmbientLight，然後把它的貢獻讀成
  // 間接光生效。
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(60, 80, 60);
  root.add(sun);

  const volume = new WW.IrradianceVolume({
    min: new THREE.Vector3(-ROOM, 0, -ROOM),
    size: new THREE.Vector3(ROOM * 2, ROOM, ROOM * 2),
    resolution: [probeRes, Math.max(2, probeRes >> 1), probeRes],
    intensity,
  });

  // ## 一塊會動的藍板子
  //
  // 場景裡除了它以外沒有任何藍色，所以「箱子那一面有沒有變藍」是個
  // 只有它做得出來的訊號。一開始放得很遠，免得影響第一次烘。
  const blocker = new THREE.Mesh(new THREE.BoxGeometry(8, 8, 1), makeMaterial(0x1030ff, 0.9));
  blocker.position.set(0, 4, ROOM - 2);
  root.add(blocker);

  const materials = WW.applyIrradiance(volume, root);

  // ## 量測用的相機與 target
  //
  // 機位與兩個頁面畫出來的那一個一樣（`(-34, 16, -34)` 看向 `(0, 12, 0)`），
  // 但**尺寸固定**：畫布大小兩邊不見得一樣，而「畫面的第幾個像素」要是同
  // 一件事才比得下去。
  const measureCamera = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 500);
  measureCamera.position.set(-34, 16, -34);
  measureCamera.lookAt(0, 12, 0);
  measureCamera.updateMatrixWorld(true);
  const measureTarget = new THREE.WebGLRenderTarget(1280, 720, {
    colorSpace: THREE.NoColorSpace,
  });

  return {
    root,
    volume,
    bake: (renderer, scene) =>
      WW.bakeIrradiance(renderer, scene, volume, { budgetMs: 12, faceSize }),
    setEnabled: async (on) => {
      // 強度歸零就等於沒有間接光，而且**走的是同一條 shader 路徑** ——
      // 換材質做 A/B 的話比的是兩個不同的著色器，那個比較沒有意義。
      volume.intensity = on ? 1 : 0;
      // WebGL 上這一行就夠了。node 材質（WebGPU）那條路改不動強度，所以
      // 那邊的 A/B 是開兩次頁面（見 tools/gi-check）。
    },
    stats: () => ({
      probes: volume.probeCount,
      baked: volume.baked,
      materials,
      stale: volume.stale,
    }),
    setSun: (phase) => {
      // 從一側掃到另一側。角度差夠大，間接光的顏色才分得出來。
      const angle = Math.PI * (0.2 + phase * 0.6);
      sun.position.set(Math.cos(angle) * 90, 80, Math.sin(angle) * 90);
      sun.updateMatrixWorld(true);
      const centre = volume.min.clone().addScaledVector(volume.size, 0.5);
      volume.invalidateAround(centre, volume.size.length());
    },
    volumePhase: (t) => {
      volume.phase = t;
      volume.upload();
    },
    invalidateAll: () => {
      // 半徑給整個體積的對角線，一次蓋滿 —— 太陽移動就是這個形狀。
      const centre = volume.min.clone().addScaledVector(volume.size, 0.5);
      return volume.invalidateAround(centre, volume.size.length());
    },
    moveBlocker: (x, y, z) => {
      // **搬之前也要標**：板子原本站的地方那幾顆探針記著它的藍色，
      // 不重烘的話它走了藍色還留在原地。
      let marked = volume.invalidateAround(blocker.position, 14);
      blocker.position.set(x, y, z);
      blocker.updateMatrixWorld(true);
      marked += volume.invalidateAround(blocker.position, 14);
      return marked;
    },
    renderedWindowAsync: async (renderer, scene, u, v, size) => {
      const gl = renderer as THREE.WebGLRenderer;
      const previous = gl.getRenderTarget();
      gl.setRenderTarget(measureTarget);
      gl.render(scene, measureCamera);
      gl.setRenderTarget(previous);
      const x = Math.min(
        measureTarget.width - size,
        Math.max(0, Math.round(u * measureTarget.width) - (size >> 1)),
      );
      const y = Math.min(
        measureTarget.height - size,
        Math.max(0, Math.round(v * measureTarget.height) - (size >> 1)),
      );
      const data = await readPixelsAsync(
        renderer,
        measureTarget,
        x,
        y,
        size,
        size,
        (n) => new Uint8Array(n),
      );
      const sum = [0, 0, 0];
      for (let i = 0; i < size * size; i++) {
        for (let c = 0; c < 3; c++) sum[c]! += data[i * 4 + c] ?? 0;
      }
      return sum.map((value) => value / (size * size) / 255);
    },
    measureScreenSpace: (renderer, scene, camera, rect) => {
      // ## 先把場景畫進一張 target，那就是 SSGI 的輸入
      //
      // SSGI 收集的是**畫面上已經有的像素**，所以它需要一張畫好的場景。
      // 直接拿畫布是不行的：畫布不是貼圖。
      const size = new THREE.Vector2();
      renderer.getDrawingBufferSize(size);
      const sceneTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        type: THREE.HalfFloatType,
      });
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(sceneTarget);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);

      const params = new URLSearchParams(location.search);
      const ssgi = new WW.ScreenSpaceGI({
        radius: Number(params.get('ssgiRadius') ?? 40),
        scale: Number(params.get('ssgiScale') ?? 0.5),
      });
      // 先跑幾次暖機（著色器編譯、target 配置），再計時。第一次一定最慢，
      // 而拿第一次當代表會把編譯時間算成每幀成本。
      const world = WW.worldFor(scene);
      for (let warm = 0; warm < 3; warm++) {
        world.beginFrame();
        ssgi.render(renderer, scene, camera, { color: sceneTarget.texture });
      }
      renderer.getContext().finish();
      const started = performance.now();
      const ROUNDS = 20;
      for (let i = 0; i < ROUNDS; i++) {
        world.beginFrame();
        ssgi.render(renderer, scene, camera, { color: sceneTarget.texture });
      }
      renderer.getContext().finish();
      const perFrameMs = (performance.now() - started) / ROUNDS;
      world.beginFrame();
      const indirect = ssgi.render(renderer, scene, camera, { color: sceneTarget.texture });

      // 把收集到的那張讀回來量。讀的是 SSGI 的輸出本身 —— 合成之後再量
      // 的話混著直接光，分不出是誰貢獻的。
      const readTarget = indirect as unknown as { source?: unknown };
      void readTarget;
      // ## 緩衝型別要跟 target 的型別對上
      //
      // gather target 是 HalfFloat，用 Float32Array 去讀會拿到全 0 —— 而 0
      // 看起來像「SSGI 什麼都沒收集到」，我照著那個假數字查了三個半徑才發現。
      //
      // 同一個坑今天已經踩過一次（烘探針的解碼），只是那次是反過來：把半精度
      // 的位元樣式當成數值用。
      // ## 讀的矩形要換算到收集圖的解析度
      //
      // 傳進來的是**畫布**座標，而收集圖預設是半解析度。不換算的話讀到的是
      // 別的地方（甚至整個出界），而出界讀回來是全 0 —— 又一次「量錯地方」，
      // 而且長得完全像「SSGI 什麼都沒收集到」。
      const target = ssgiTargetOf(ssgi);
      const ratioX = target.width / size.x;
      const ratioY = target.height / size.y;
      const rx = Math.max(0, Math.floor(rect[0] * ratioX));
      const ry = Math.max(0, Math.floor(rect[1] * ratioY));
      const rw = Math.max(1, Math.floor(rect[2] * ratioX));
      const rh = Math.max(1, Math.floor(rect[3] * ratioY));
      const buffer = new Uint16Array(rw * rh * 4);
      renderer.setRenderTarget(target);
      renderer.readRenderTargetPixels(target, rx, ry, rw, rh, buffer);
      renderer.setRenderTarget(previous);

      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < buffer.length; i += 4) {
        r += THREE.DataUtils.fromHalfFloat(buffer[i]!);
        g += THREE.DataUtils.fromHalfFloat(buffer[i + 1]!);
        b += THREE.DataUtils.fromHalfFloat(buffer[i + 2]!);
      }
      const n = buffer.length / 4;
      ssgi.dispose();
      sceneTarget.dispose();
      return { r: r / n, g: g / n, b: b / n, perFrameMs };
    },
    bakeStale: async (renderer, scene) => {
      let total = 0;
      let guard = 0;
      while (volume.stale > 0 && guard++ < 500) {
        total += await WW.bakeIrradiance(renderer, scene, volume, { budgetMs: 12, faceSize });
      }
      return total;
    },
    sampleCpu: (p, n) => {
      const v = volume.sampleAt(new THREE.Vector3(...p), new THREE.Vector3(...n));
      return [v.x, v.y, v.z];
    },
  };
}
