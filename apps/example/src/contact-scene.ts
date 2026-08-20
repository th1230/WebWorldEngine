import * as THREE from 'three';
import * as WW from '@webworld/three';
import { readPixelsAsync } from './readback.ts';

/**
 * 接觸陰影的證明場景：一個箱子**貼在**地面上。
 *
 * ## 判準是「箱子旁邊暗、空地不暗」
 *
 * 只驗「有東西變暗了」是不夠的 —— 自我遮蔽的 bug 會讓**整片**變暗，而那也
 * 通過「有變暗」這個檢查。所以要同時驗空曠處**沒有**被暗掉。
 *
 * 這與間接光那條「背光面偏紅，而紅只可能來自紅牆」是同一個判準形狀：訊號要
 * 有一個乾淨的來源，而且要有一個不該有訊號的對照點。
 */

/** 箱子的半邊長。取樣點要靠它算，所以兩邊共用同一個數字。 */
const HALF = 3;

export interface ContactScene {
  root: THREE.Group;
  camera: THREE.PerspectiveCamera;
  /** 光照過來的方向（從光源指向場景）。 */
  lightDirection: THREE.Vector3;
  /** 跑一次：更新深度法線，然後算接觸陰影。 */
  render: (renderer: THREE.WebGLRenderer) => void;
  /** 讀某個世界座標投影到畫面上那一點的遮蔽值，0–1。 */
  sample: (renderer: THREE.WebGLRenderer, point: THREE.Vector3) => number;
  /**
   * 同一件事，非同步 —— 兩個後端都走得通。
   *
   * WebGPU 沒有同步的讀回，所以跨後端比對只能走這一支。
   */
  sampleAsync: (renderer: unknown, point: THREE.Vector3) => Promise<number>;
  /**
   * 直接讀 gbuffer 的法線 —— 比輸出更上游一層。
   *
   * 兩個後端的效果對不起來的時候，要先知道**輸入**一不一樣。輸入就不同的話，
   * 再怎麼查著色器都是白費。
   */
  sampleNormalAsync: (renderer: unknown, point: THREE.Vector3) => Promise<number[]>;
  /**
   * 某一點周圍一小塊的平均遮蔽值。
   *
   * 單點取樣落在陰影邊緣上時，差一個像素就是 0.1 與 1.0 的差別 —— 那量的是
   * 「邊緣剛好落在哪」而不是「效果對不對」。天空那邊也是同一個理由改成整面
   * 平均的。
   */
  sampleWindowAsync: (renderer: unknown, point: THREE.Vector3, size: number) => Promise<number>;
  /** 遮罩的尺寸，以及某個世界點投影到的像素座標。診斷讀回方向用。 */
  probePixel: (point: THREE.Vector3) => { width: number; height: number; x: number; y: number };
  /** 直接讀某個像素 —— 不做任何座標換算。 */
  readPixelAsync: (renderer: unknown, x: number, y: number) => Promise<number>;
  /** gbuffer 法線的粗略縮圖 —— 輸入有沒有結構，圖看得出來。 */
  normalMapAsync: (renderer: unknown) => Promise<number[]>;
  /** 遮罩的粗略縮圖（16×9 的平均）。分布不對的時候，數字看不出來，圖看得出來。 */
  maskMapAsync: (renderer: unknown) => Promise<number[]>;
  /** 遮罩裡有多少比例是暗的 —— 兩個後端都走得通的版本。 */
  coverageAsync: (renderer: unknown) => Promise<number>;
  /** 把中間值畫出來（只有 node 那條路有）。 */
  setDebug: (mode: number) => void;
  /** 等 WebGPU 那條路建好（先畫幾幀讓它把材質建出來）。 */
  nodeReady: (renderer: unknown) => Promise<void>;
  /** 幾個有意義的取樣點，測試要用同一組。 */
  points: {
    contact: THREE.Vector3;
    open: THREE.Vector3;
    lit: THREE.Vector3;
    terminator: THREE.Vector3;
    under: THREE.Vector3;
  };
  /**
   * 整張遮蔽圖裡有多少比例的像素是暗的（< 0.9）。
   *
   * ## 為什麼要看整張，不是看幾個點
   *
   * 手放的取樣點只驗得到「我想到的那些位置」。實測把法線偏移與厚度上限
   * 各拿掉一次，**五個手放的點一個都沒變** —— 那兩條路徑根本沒被那些點
   * 走到，於是斷言永遠是綠的。
   *
   * 整張的比例不會漏：那兩個 bug 的症狀都是「暗掉的範圍變大」，而範圍
   * 這件事只有看整張才量得到。
   */
  coverage: (renderer: THREE.WebGLRenderer) => number;
  setStrength: (value: number) => void;
  /**
   * 把相機移到另一個角度。
   *
   * 光的方向如果沒有換到視空間，陰影會**跟著相機轉** —— 而靜止的相機
   * 看不出來。換個角度再量同一個世界座標，答案應該一樣。
   */
  setCameraAngle: (which: 0 | 1) => void;
}

/** ContactShadows 的內部 target —— 讀回像素要用它，而那不是公開介面。 */
function targetOf(shadows: WW.ContactShadows): THREE.WebGLRenderTarget {
  return (shadows as unknown as { target: THREE.WebGLRenderTarget }).target;
}

export function makeContactScene(): ContactScene {
  const root = new THREE.Group();

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardMaterial({ color: 0xb0b0b0, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  root.add(ground);

  // 箱子**剛好**站在地面上：底面 y = 0。浮起來一點點的話接觸陰影本來就該
  // 變淡，而那會讓測試在量一個自己造出來的假象。
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(HALF * 2, HALF * 2, HALF * 2),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
  );
  box.position.set(0, HALF, 0);
  root.add(box);

  // ## 一顆球：平地驗不到自我遮蔽
  //
  // 拿掉法線偏移之後平坦的地面照樣正常（射線一步就離開地面了），所以
  // 那條 bug 在只有平面的場景裡**驗不到**。曲面才會讓射線擦著自己走。
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(3, 48, 32),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
  );
  sphere.position.set(14, 3, 0);
  root.add(sphere);

  // 低角度的光：接觸陰影在光很斜的時候最明顯，而那也是它最該生效的時候。
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(40, 14, 0);
  root.add(sun);
  const lightDirection = new THREE.Vector3(0, 0, 0).sub(sun.position).normalize();

  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.5, 500);
  camera.position.set(-18, 12, 26);
  camera.lookAt(0, 2, 0);
  camera.updateMatrixWorld(true);

  // ## 厚度上限的遮擋板要用**算的**擺，不是用猜的
  //
  // 要驗的是「螢幕空間上擋住了，但深度上遠得多，所以不算遮蔽」。第一版
  // 隨手把一個箱子丟在空中，結果它在螢幕上根本沒有蓋到追蹤路徑 —— 那條
  // 斷言於是永遠是綠的（把厚度檢查拿掉照樣過）。
  //
  // 這裡改成從相機拉一條線到「追蹤路徑上的某一點」，把板子放在那條線的
  // 三成處。螢幕空間的重疊因此是**構造出來的**，不是碰運氣。
  const groundProbe = new THREE.Vector3(24, 0.02, 0);
  const towardLight = lightDirection.clone().negate().normalize();
  const marchMid = groundProbe.clone().addScaledVector(towardLight, 1.5);
  const blocker = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 6),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, side: THREE.DoubleSide }),
  );
  blocker.position.copy(camera.position).lerp(marchMid, 0.3);
  blocker.lookAt(camera.position);
  root.add(blocker);

  const shadows = new WW.ContactShadows({
    distance: 2.5,
    thickness: 1.2,
    steps: 16,
    strength: 0.9,
  });

  const scene = new THREE.Scene();
  scene.add(root);

  // 全解析度的深度法線。預設是半解析度（那對真的應用是對的取捨），但這裡是
  // 量測台 —— 重取樣的誤差會混進每一個判準裡，而那不是這一關要量的東西。
  const world = WW.worldFor(scene);
  world.setDepthNormals({ scale: 1 });

  /**
   * 伸手拿共用深度法線那張 render target。
   *
   * 套件只公開 `normalTexture` 與 `depthTexture` —— 對使用者那就夠了。而
   * `readPixelsAsync` 要的是 target 本身，所以量測台這裡轉一次型。這是
   * **關卡專用**的，不是使用者要做的事。
   */
  const readTargetOf = (gbuffer: WW.SceneDepthNormals): THREE.WebGLRenderTarget =>
    (gbuffer as unknown as { target: THREE.WebGLRenderTarget }).target;

  const pixel = new Uint8Array(4);
  const projected = new THREE.Vector3();

  /** 一幀。深度法線是效果自己去 world 拿的 —— 這裡只推進幀號。 */
  const drawOnce = (renderer: THREE.WebGLRenderer): void => {
    world.beginFrame();
    shadows.render(renderer, scene, camera, { lightDirection });
  };

  return {
    root,
    camera,
    lightDirection,
    render: drawOnce,
    normalMapAsync: async (renderer) => {
      const target = readTargetOf(world.depthNormals(renderer as THREE.WebGLRenderer, camera));
      const data = await readPixelsAsync(
        renderer,
        target,
        0,
        0,
        target.width,
        target.height,
        (n) => new Uint8Array(n),
      );
      const out: number[] = [];
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 16; c++) {
          let sum = 0;
          let n = 0;
          for (
            let y = Math.floor((r / 9) * target.height);
            y < Math.floor(((r + 1) / 9) * target.height);
            y += 2
          ) {
            for (
              let x = Math.floor((c / 16) * target.width);
              x < Math.floor(((c + 1) / 16) * target.width);
              x += 2
            ) {
              sum += data[(y * target.width + x) * 4 + 1] ?? 0;
              n++;
            }
          }
          out.push(Math.round(sum / Math.max(n, 1)));
        }
      }
      return out;
    },
    maskMapAsync: async (renderer) => {
      const target = targetOf(shadows);
      const data = await readPixelsAsync(
        renderer,
        target,
        0,
        0,
        target.width,
        target.height,
        (n) => new Uint8Array(n),
      );
      const cols = 16;
      const rows = 9;
      const out: number[] = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          let sum = 0;
          let n = 0;
          for (
            let y = Math.floor((r / rows) * target.height);
            y < Math.floor(((r + 1) / rows) * target.height);
            y += 2
          ) {
            for (
              let x = Math.floor((c / cols) * target.width);
              x < Math.floor(((c + 1) / cols) * target.width);
              x += 2
            ) {
              sum += data[(y * target.width + x) * 4] ?? 0;
              n++;
            }
          }
          out.push(Math.round(sum / Math.max(n, 1)));
        }
      }
      return out;
    },
    coverageAsync: async (renderer) => {
      const target = targetOf(shadows);
      const data = await readPixelsAsync(
        renderer,
        target,
        0,
        0,
        target.width,
        target.height,
        (n) => new Uint8Array(n),
      );
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if ((data[i] ?? 255) < 230) dark++;
      return dark / (target.width * target.height);
    },
    probePixel: (point) => {
      const target = targetOf(shadows);
      projected.copy(point).project(camera);
      return {
        width: target.width,
        height: target.height,
        x: Math.round(((projected.x + 1) / 2) * target.width),
        y: Math.round(((projected.y + 1) / 2) * target.height),
      };
    },
    readPixelAsync: async (renderer, x, y) => {
      const target = targetOf(shadows);
      const data = await readPixelsAsync(renderer, target, x, y, 1, 1, (n) => new Uint8Array(n));
      return (data[0] ?? 0) / 255;
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
      const data = await readPixelsAsync(
        renderer,
        target,
        x,
        y,
        size,
        size,
        (n) => new Uint8Array(n),
      );
      let sum = 0;
      for (let i = 0; i < size * size; i++) sum += data[i * 4] ?? 0;
      return sum / (size * size) / 255;
    },
    sampleNormalAsync: async (renderer, point) => {
      const target = readTargetOf(world.depthNormals(renderer as THREE.WebGLRenderer, camera));
      projected.copy(point).project(camera);
      const x = Math.min(
        target.width - 1,
        Math.max(0, Math.round(((projected.x + 1) / 2) * target.width)),
      );
      const y = Math.min(
        target.height - 1,
        Math.max(0, Math.round(((projected.y + 1) / 2) * target.height)),
      );
      const data = await readPixelsAsync(renderer, target, x, y, 1, 1, (n) => new Uint8Array(n));
      return [(data[0] ?? 0) / 255, (data[1] ?? 0) / 255, (data[2] ?? 0) / 255];
    },
    setDebug: (mode) => {
      (shadows as unknown as { debugMode: number }).debugMode = mode;
    },
    sampleAsync: async (renderer, point) => {
      const target = targetOf(shadows);
      projected.copy(point).project(camera);
      const x = Math.min(
        target.width - 1,
        Math.max(0, Math.round(((projected.x + 1) / 2) * target.width)),
      );
      const y = Math.min(
        target.height - 1,
        Math.max(0, Math.round(((projected.y + 1) / 2) * target.height)),
      );
      const data = await readPixelsAsync(
        renderer,
        target,
        x,
        y,
        1,
        1,
        (length) => new Uint8Array(length),
      );
      return (data[0] ?? 0) / 255;
    },
    nodeReady: async (renderer) => {
      // ## 要等的是**真的時間**，不是 microtask
      //
      // node 材質是動態 `import()` 進來的，而那需要好幾個 macrotask。
      // 第一版用 `await Promise.resolve()`（microtask）推了 30 圈，import
      // 一次都沒完成 —— 於是 target 從來沒被畫過，WebGPU 上讀它直接丟
      // 「Cannot read properties of undefined (reading format)」。
      //
      // 那個錯誤訊息完全看不出是「還沒建好」。
      for (let i = 0; i < 60; i++) {
        drawOnce(renderer as THREE.WebGLRenderer);
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    },
    sample: (renderer, point) => {
      const target = targetOf(shadows);
      projected.copy(point).project(camera);
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
    points: {
      // 背光那一側、緊貼箱子的地面。光從 +x 過來，所以影子落在 −x 那側。
      contact: new THREE.Vector3(-HALF - 0.6, 0.02, 0),
      // 空曠的地面，離箱子很遠 —— 這裡不該有接觸陰影。
      open: new THREE.Vector3(-34, 0.02, 22),
      // 球體上靠近明暗交界的地方：那裡 dot(法線, 光) 剛好大於 0，是自我
      // 遮蔽最容易發作的位置。它應該是**亮的**。
      terminator: new THREE.Vector3(14 - 0.75, 3 + 2.9, 0),
      // 浮空箱子下方的地面。往光源追會在螢幕空間掃過那個箱子，但它在深度
      // 上遠得多 —— 不該算成遮蔽。
      under: new THREE.Vector3(24, 0.02, 0),
      // 迎光那一側的地面：也不該有。
      lit: new THREE.Vector3(HALF + 2.5, 0.02, 0),
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
    setCameraAngle: (which) => {
      if (which === 0) camera.position.set(-18, 12, 26);
      // 第二個角度**必須還看得見接觸點**。第一版放在 +x 那側，於是那個點
      // 被箱子自己擋住了 —— 量到的是箱子的正面，而測試紅了卻不是程式的錯。
      else camera.position.set(-24, 16, -18);
      camera.lookAt(0, 2, 0);
      camera.updateMatrixWorld(true);
    },
    setStrength: (value) => {
      (shadows as unknown as { options: { strength: number } }).options.strength = value;
    },
  };
}
